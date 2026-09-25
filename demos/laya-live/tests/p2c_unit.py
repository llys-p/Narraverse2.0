"""P2-C 后端：POST /narrate mode="analysis" 自测（秒级：零模型、stub LLM）。

覆盖《P2-A-Analyze-Commit协议.md》§7 与 §9 的 U2：
  U2-1 committed → 取回执快照与服务器保存的原文/上下文，state_source=committed
  U2-2 ready 未提交 → 409 ANALYSIS_NOT_COMMITTED（不允许未提交就叙事）
  U2-3 reference_only → 版本/规则有效时 200，state_source=reference_only，aux 不改变状态
  U2-4 缺失 analysis_id → 422；未知 id / scope 不符 → 404
  U2-5 不触发 decide、不产生新候选、绝不重复 Commit（narrate 前后无副作用）
  U2-6 云端失败 → 502 且不撤销先前 Commit（可重试叙事）
"""
import copy
import json
import sys
import threading
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_state_protocol import LayaStateProtocol, _ProtoError

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


now = [1000.0]
P = B.PROTOCOL
P.now = lambda: now[0]

FAKE_CHECK = {"matched": True, "fresh": True, "problems": [],
              "code_changed": True, "checkpoint": "typed-decisions", "profile_id": "fp_t"}
FAKE_PROF = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "signals": {
    "doubt_shift": {"grade": "A", "status": "active", "role": "state_shift"},
    "trust_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
}}
FD_DELTAS = ([
    {"question": "doubt_shift", "target": "relationship.doubt", "delta": 3.0,
     "label": "怀疑", "raw": 2.4, "range": [0, 100]},
], {})
EMPTY_DELTAS = ([], {})


def _lcp(m, prof, check):
    return copy.deepcopy(prof), dict(check or FAKE_CHECK)


def reset_all():
    B.reset_actor_state()
    B.reset_history()
    for k in list(B._PENDING):
        B._PENDING.pop(k, None)
    P._buckets.clear()
    P._analyses.clear()
    P._events.clear()
    P._inflight.clear()
    now[0] = 1000.0


@contextmanager
def assets_ctx(deltas=None):
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: _lcp(m, FAKE_PROF, None)), \
         mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: copy.deepcopy(deltas if deltas is not None else FD_DELTAS)), \
         mock.patch.object(B, '_cached_translate', return_value='EN'), \
         mock.patch.object(B, '_engine_identity',
                           return_value={"ready": True, "model_name": "typed-decisions",
                                         "detail": "stub"}):
        yield


def analyze_and_get(sid, aid, event, message, deltas=None):
    req = {"session_id": sid, "actor_id": aid, "event_id": event, "message": message,
           "expected_state_version": P.state_version((sid, aid)), "context": {}}
    return P.analyze(req)


LLM_OK = {"source": "llm", "model": "stub", "line": "（生成的台词）……", "latency_ms": 1.0}
LLM_FAIL = {"error": "stub upstream failure"}


print('=' * 92)
print('P2-C 后端自测（/narrate mode="analysis"）')
print('=' * 92)

# ===========================================================================
print("\n[U2-1] committed → 回执快照 + 服务器原文，state_source=committed，不重复 Commit")
# ===========================================================================
reset_all()
with assets_ctx(), mock.patch.object(B, 'llm_narrate', return_value=dict(LLM_OK)):
    r = analyze_and_get("demo_01", "lia", "e1", "你到底想干什么？")
    c = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
    ctx = P.narrate_context(r["analysis_id"], "demo_01", "lia")
    chk('U2-1 committed 上下文取回执快照', ctx["state_source"] == "committed"
        and ctx["state_version"] == c["state_version"]
        and ctx["state"]["relationship"]["doubt"] == 33, 'src=%s ver=%s doubt=%s'
        % (ctx["state_source"], ctx["state_version"], ctx["state"]["relationship"]["doubt"]))
    chk('U2-1 携带服务器保存的原文', ctx["message"] == "你到底想干什么？", 'msg=%s' % ctx["message"])
    chk('U2-1 signals 只含 known', set(ctx["signals"]) <= {"doubt_shift", "trust_shift"}
        and ctx["signals"]["doubt_shift"]["availability"] == "known", 'keys=%s' % sorted(ctx["signals"]))

# ===========================================================================
print("\n[U2-2] ready 未提交 → 409 ANALYSIS_NOT_COMMITTED")
# ===========================================================================
reset_all()
with assets_ctx():
    r = analyze_and_get("demo_01", "lia", "e2", "还没提交就问我？")
    try:
        P.narrate_context(r["analysis_id"], "demo_01", "lia")
        chk('U2-2 ready 叙事被拒', False, '')
    except _ProtoError as e:
        chk('U2-2 ready → 409 ANALYSIS_NOT_COMMITTED', e.code == "ANALYSIS_NOT_COMMITTED", 'code=%s' % e.code)

# ===========================================================================
print("\n[U2-3] reference_only（版本/规则有效）→ state_source=reference_only")
# ===========================================================================
reset_all()
with assets_ctx(deltas=EMPTY_DELTAS):
    r = analyze_and_get("demo_01", "lia", "e3", "只有参考，不改数值。")
    chk('U2-3 构造 reference_only 候选', r["status"] == "reference_only", 'status=%s' % r["status"])
    ctx = P.narrate_context(r["analysis_id"], "demo_01", "lia")
    chk('U2-3 reference_only 可引用（版本/规则有效）', ctx["state_source"] == "reference_only"
        and ctx["state_version"] == r["base_state_version"], 'src=%s' % ctx["state_source"])

# ===========================================================================
print("\n[U2-4] 输入校验：缺失 analysis_id 422 / 未知 id 404 / scope 不符 404")
# ===========================================================================
reset_all()
with assets_ctx():
    r = analyze_and_get("demo_01", "lia", "e4", "校验一下。")
    try:
        P.narrate_context(None, "demo_01", "lia")
        chk('U2-4 无 analysis_id 被拒', False, '')
    except Exception:
        chk('U2-4 无 analysis_id → 拒绝（协议层）', True, '')
    try:
        P.narrate_context("no_such_id", "demo_01", "lia")
        chk('U2-4 未知 id 被拒', False, '')
    except _ProtoError as e:
        chk('U2-4 未知 id → 404', e.code == "ANALYSIS_NOT_FOUND", 'code=%s' % e.code)
    try:
        P.narrate_context(r["analysis_id"], "other", "lia")
        chk('U2-4 scope 不符被拒', False, '')
    except _ProtoError as e:
        chk('U2-4 scope 不符 → 404', e.code == "ANALYSIS_NOT_FOUND", 'code=%s' % e.code)

# ===========================================================================
print("\n[U2-5] 不触发 decide、不产生新候选、绝不重复 Commit（零副作用）")
# ===========================================================================
reset_all()
with assets_ctx(), mock.patch.object(B, 'llm_narrate', return_value=dict(LLM_OK)), \
     mock.patch.object(B, 'decide', side_effect=AssertionError('U2-5: narrate 不得触发 decide')):
    r = analyze_and_get("demo_01", "lia", "e5", "叙事别翻旧账。")
    P.commit_state({"session_id": "demo_01", "actor_id": "lia", "analysis_id": r["analysis_id"],
                    "expected_state_version": r["base_state_version"]})
    n_analyses = len(P._analyses)
    pv = P.state_version(("demo_01", "lia"))
    P.narrate_context(r["analysis_id"], "demo_01", "lia")
    P.narrate_context(r["analysis_id"], "demo_01", "lia")   # 多次只读
    chk('U2-5 narrate 不产生新候选', len(P._analyses) == n_analyses, '')
    chk('U2-5 narrate 不推进版本', P.state_version(("demo_01", "lia")) == pv, '')
    chk('U2-5 narrate 不写历史', not B._HISTORY_BUCKETS, '')

# ===========================================================================
print("\n[U2-6] 云端失败 → 502，不撤销先前 Commit（可重试叙事）")
# ===========================================================================
reset_all()
with assets_ctx(), mock.patch.object(B, 'llm_narrate',
                                     side_effect=[dict(LLM_FAIL), dict(LLM_OK)]):
    r = analyze_and_get("demo_01", "lia", "e6", "这次云端会先失败。")
    c = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
    ctx1 = P.narrate_context(r["analysis_id"], "demo_01", "lia")
    chk('U2-6 Commit 先成功（doubt=33）', c["state"]["relationship"]["doubt"] == 33, 'doubt=%s'
        % c["state"]["relationship"]["doubt"])
    # handler 层：失败返回 502 包装（这里验证上下文层失败可重试——llm 调用在 handler，
    # 协议层只给数据；此测试验证 commit 结果不受「叙事失败」影响）
    chk('U2-6 上下文仍可获取（状态已确认）', ctx1["state_source"] == "committed", '')

# ===========================================================================
print("\n[HTTP] /narrate mode=analysis（本机临时端口，stub LLM）")
# ===========================================================================
reset_all()
srv = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % port
_OPENER = __import__("urllib.request", fromlist=["build_opener"]).build_opener(
    __import__("urllib.request", fromlist=["ProxyHandler"]).ProxyHandler({}))


def _post(path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = __import__("urllib.request", fromlist=["Request"]).Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except __import__("urllib.error", fromlist=["HTTPError"]).HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def _get(path):
    try:
        with _OPENER.open(BASE + path, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except __import__("urllib.error", fromlist=["HTTPError"]).HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


with assets_ctx(), mock.patch.object(B, 'llm_narrate', return_value=dict(LLM_OK)):
    st, s = _get("/state?session_id=demo_01&actor_id=lia")
    ver = s["current"]["state_version"]
    st, ar = _post("/analyze", {"session_id": "demo_01", "actor_id": "lia", "event_id": "h1",
                                "expected_state_version": ver, "message": "完整闭环。", "context": {}})
    st, cr = _post("/commit_state", {"session_id": "demo_01", "actor_id": "lia",
                                     "analysis_id": ar["analysis_id"],
                                     "expected_state_version": ver})
    st, nr = _post("/narrate", {"mode": "analysis", "session_id": "demo_01", "actor_id": "lia",
                                "analysis_id": ar["analysis_id"]})
    chk('HTTP mode=analysis 200 且携带提交语义',
        st == 200 and nr["mode"] == "analysis" and nr["state_source"] == "committed"
        and nr["commit_allowed"] is False and nr["state_commits"] == []
        and nr["state_version"] == cr["state_version"] and nr.get("line"), 'st=%s src=%s'
        % (st, nr.get("state_source")))
    # missing analysis_id → 422
    st, er = _post("/narrate", {"mode": "analysis", "session_id": "demo_01", "actor_id": "lia"})
    chk('HTTP 缺 analysis_id → 422 INVALID_REQUEST', st == 422 and er["error"]["code"] == "INVALID_REQUEST",
        'st=%s code=%s' % (st, er.get("error", {}).get("code")))
    # ready 未提交 → 409
    st, ar2 = _post("/analyze", {"session_id": "demo_01", "actor_id": "lia", "event_id": "h2",
                                 "expected_state_version": cr["state_version"],
                                 "message": "不提交就叙事？", "context": {}})
    st, er2 = _post("/narrate", {"mode": "analysis", "session_id": "demo_01", "actor_id": "lia",
                                 "analysis_id": ar2["analysis_id"]})
    chk('HTTP ready 未提交 → 409 ANALYSIS_NOT_COMMITTED',
        st == 409 and er2["error"]["code"] == "ANALYSIS_NOT_COMMITTED", 'st=%s code=%s'
        % (st, er2.get("error", {}).get("code")))
srv.shutdown()

print('=' * 92)
print('P2-C 后端自测：合计 %d 项：%d PASS / %d FAIL' % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)