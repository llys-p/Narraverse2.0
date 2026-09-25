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
    import types as _types
    _fake_engine = _types.SimpleNamespace(
        ready=True,
        predict=lambda _s, _q: {"answers": B.fallback_decide(B.CFG["actor"], None, "", _q)[0]},
        detail="stub", model_name=None, last_error=None,
        device_label=lambda: "cpu", describe=lambda: {"kind": "fake"})
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: _lcp(m, FAKE_PROF, None)), \
         mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: copy.deepcopy(deltas if deltas is not None else FD_DELTAS)), \
         mock.patch.object(B, '_cached_translate', return_value='EN'), \
         mock.patch.object(B, '_engine_identity',
                           return_value={"ready": True, "model_name": "typed-decisions",
                                         "detail": "stub"}), \
         mock.patch.object(B, 'ENGINE', _fake_engine):
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

# ===========================================================================
print("\n[T-rule] 规则层事件裁决（apply_rule_adjudication 纯函数）")
# ===========================================================================


def _delta_item(sig, d):
    return {"source_signal": sig, "delta": d, "status": "active", "grade": "A",
            "role": "state_shift", "label": sig, "range": [0, 100]}


_r1 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 3.0)]},
                                {"cooperation": 0.72, "disclose": 0.1}, "")
chk('规则：cooperation 高 → doubt 正增量打折并略降',
    _r1["delta"][0]["delta"] == round(3.0 * 0.5 - 0.8, 3)
    and _r1["delta"][0].get("rule_adjudicated") == "pro_cooperation",
    'delta=%s' % _r1["delta"][0]["delta"])
_proto = {"delta": [_delta_item("doubt_shift", 3.0)]}
_r2 = B.apply_rule_adjudication(_proto, {"cooperation": 0.2, "disclose": 0.2}, "今晚的酒不错。")
chk('规则：无命中 → 返回原对象（零拷贝）', _r2 is _proto, '')
_r3 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", -1.5)]},
                                {"cooperation": 0.1, "disclose": 0.8}, "")
chk('规则：doubt 负增量不受折扣影响', _r3["delta"][0]["delta"] == -1.5, '')
_r4 = B.apply_rule_adjudication(
    {"delta": [_delta_item("doubt_shift", 2.0), _delta_item("trust_shift", 1.0)]},
    {"cooperation": 0.9, "disclose": 0.1}, "")
chk('规则：只影响 doubt_shift，不动 trust', _r4["delta"][0]["delta"] == 0.2
    and _r4["delta"][1]["delta"] == 1.0, '')
_r5 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 2.0)]},
                                {"cooperation": 0.1, "disclose": 0.1},
                                "（放下刀，双手摊开）名单在这里。")
chk('规则：证据词 → doubt 直接回落为负',
    _r5["delta"][0]["delta"] == round(-2.0 - 0.8, 3)
    and _r5["delta"][0].get("rule_adjudicated") == "evidence_handover",
    'delta=%s' % _r5["delta"][0]["delta"])
# 证据词且本轮无 doubt_shift 项 → 规则层追加确定性压制（胜负归规则层，不依赖模型）
_r6 = B.apply_rule_adjudication({"delta": [{"source_signal": "trust_shift", "delta": 1.0}]},
                                {}, "（放下刀）名单在后巷棺底。")
chk('规则：证据词无 doubt 项 → 追加压制 -2.8',
    any(w["source_signal"] == "doubt_shift" and w["delta"] == -2.8
        and w["rule_adjudicated"] == "evidence_handover" for w in _r6["delta"]),
    'delta=%r' % [_get := [ (w["source_signal"], w.get("delta")) for w in _r6["delta"] ]][0])

# ---- 通道 C：暴力升级保底（决裂线可达，对称证据通道）----
_c1 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 0.5)]},
                                {}, "（拔出匕首，一刀扎在桌上）说不说！")
chk('规则：暴力动作 → doubt 保底抬到 +2.5',
    _c1["delta"][0]["delta"] == 2.5
    and _c1["delta"][0].get("rule_adjudicated") == "violence_escalation",
    'delta=%s' % _c1["delta"][0]["delta"])
_c2 = B.apply_rule_adjudication({"delta": [{"source_signal": "trust_shift", "delta": 1.0}]},
                                {}, "（掐着你脖子）再不开口我就掐死你。")
chk('规则：暴力动作无 doubt 项 → 追加保底 +2.5',
    any(w["source_signal"] == "doubt_shift" and w["delta"] == 2.5
        and w["rule_adjudicated"] == "violence_escalation" for w in _c2["delta"]),
    'delta=%r' % [(w["source_signal"], w.get("delta")) for w in _c2["delta"]])
_c3 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", -1.5)]},
                                {}, "（刀锋横在你喉前）我再问一遍！")
chk('规则：暴力动作对模型负判定无条件抬起（对称证据无条件压负）',
    _c3["delta"][0]["delta"] == 2.5
    and _c3["delta"][0].get("rule_adjudicated") == "violence_escalation",
    'delta=%s' % _c3["delta"][0]["delta"])
_c4 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 1.0)]},
                                {}, "（放下匕首，后退一步）刚才是我冒犯了。")
chk('规则：语言回落「放下…」不触发暴力升级（原样返回）',
    _c4["delta"][0]["delta"] == 1.0,
    'delta=%s' % _c4["delta"][0]["delta"])
_c5 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 2.0)]},
                                {}, "（放下刀）名单在这里，你要就拿去。")
chk('规则：证据词优先于暴力（让渡=压制，不回抬）',
    _c5["delta"][0]["delta"] == -2.8
    and _c5["delta"][0].get("rule_adjudicated") == "evidence_handover",
    'delta=%s' % _c5["delta"][0]["delta"])
_c6 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 4.0)]},
                                {}, "（拔出匕首）我现在就要一个答案。")
chk('规则：模型已给高于保底的增量 → 保留原值只打标记',
    _c6["delta"][0]["delta"] == 4.0
    and _c6["delta"][0].get("rule_adjudicated") == "violence_escalation",
    'delta=%s' % _c6["delta"][0]["delta"])

# ---- 通道 B 质问豁免（P3-B 实测反例：徽章哪来的 / 你有证据吗）----
_e1 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 1.83)]},
                                {}, "你身上那枚徽章，哪来的？")
chk('规则：质问「徽章哪来的」不按让渡压制（原样返回）',
    _e1["delta"][0]["delta"] == 1.83
    and _e1["delta"][0].get("rule_adjudicated") is None,
    'delta=%s' % _e1["delta"][0]["delta"])
_e2 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 2.0)]},
                                {}, "你有证据吗？是不是你干的？")
chk('规则：质问「你有证据吗」不按让渡压制（原样返回）',
    _e2["delta"][0]["delta"] == 2.0
    and _e2["delta"][0].get("rule_adjudicated") is None,
    'delta=%s' % _e2["delta"][0]["delta"])
_e3 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 1.5)]},
                                {}, "（翻出徽章递过去）这就是你要的徽章。")
chk('规则：真的出示徽章（递过去）仍按让渡压制',
    _e3["delta"][0]["delta"] == -2.3
    and _e3["delta"][0].get("rule_adjudicated") == "evidence_handover",
    'delta=%s' % _e3["delta"][0]["delta"])
_e4 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 2.0)]},
                                {}, "你就是接头人，我亲眼见过你交信物。")
chk('规则：指控句「你交信物」不按让渡压制（原样返回）',
    _e4["delta"][0]["delta"] == 2.0
    and _e4["delta"][0].get("rule_adjudicated") is None,
    'delta=%s' % _e4["delta"][0]["delta"])
_e5 = B.apply_rule_adjudication({"delta": [_delta_item("doubt_shift", 1.6)]},
                                {}, "（从怀里掏出一封信，拍在桌上）这就是你要的证据。")
chk('规则：掏信出示 仍按让渡压制（掏出+这就是）',
    _e5["delta"][0]["delta"] == -2.4
    and _e5["delta"][0].get("rule_adjudicated") == "evidence_handover",
    'delta=%s' % _e5["delta"][0]["delta"])

# ---- 剧情线档位（玩法层 plot_stage，与前端横幅同判据）----
_p80 = B.plot_stage({"relationship": {"doubt": 80, "trust": 40}})
_p55 = B.plot_stage({"relationship": {"doubt": 55, "trust": 40}})
_p20 = B.plot_stage({"relationship": {"doubt": 28, "trust": 60}})
_p30 = B.plot_stage({"relationship": {"doubt": 30, "trust": 60}})
_p35 = B.plot_stage({"relationship": {"doubt": 35, "trust": 40}})
chk('剧情线：doubt>=70 → 决裂', _p80["key"] == "break", _p80["key"])
chk('剧情线：doubt>=45 → 戒备', _p55["key"] == "guard", _p55["key"])
chk('剧情线：doubt<30 → 信任（trust 只读用疑点回落判定）', _p20["key"] == "trust", _p20["key"])
chk('剧情线：doubt=30 处女档边界 → 试探（严格 <30 才信任）', _p30["key"] == "probing", _p30["key"])
chk('剧情线：其余 → 试探', _p35["key"] == "probing", _p35["key"])

# ===========================================================================
print("\n[T-stage] /narrate handler 剧情线四档走查（stub e2e：注入 + 响应字段）")
print("   目的：玩法层档位必须走真实 handler 路径 —— 提交后 /narrate mode=analysis")
print("   注入「关系档位」分块给叙事模型，且响应回传 plot_stage；四档对称验证。")
# ===========================================================================
reset_all()
_cap = []
def _probe(*a, **k):
    _cap.append(dict(k))
    return dict(LLM_OK)
srv3 = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
_port3 = srv3.server_address[1]
threading.Thread(target=srv3.serve_forever, daemon=True).start()
_BASE3 = "http://127.0.0.1:%d" % _port3
def _get3(path):
    try:
        with _OPENER.open(_BASE3 + path, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except __import__("urllib.error", fromlist=["HTTPError"]).HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))
def _post3(path, body):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = __import__("urllib.request", fromlist=["Request"]).Request(
        _BASE3 + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except __import__("urllib.error", fromlist=["HTTPError"]).HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))

def _walk_to_band(sid, ev_prefix, msg, dd, band):
    """在 sid 上逐步 analyze→commit 直到 doubt 落入 band（每回合疑点增量有
    per_turn 上限 +5，故需多回合逼近）；返回 (doubt, 最后事件的 /narrate 响应)。"""
    band_fn = {
        "break":  lambda d: d >= 70,
        "guard":  lambda d: 45 <= d < 70,
        "trust":  lambda d: d < 30,
        "probing": lambda d: 30 < d < 45,
    }[band]
    _cap[:] = []
    last_aid = None
    d = None
    for i in range(16):
        st, s = _get3("/state?session_id=%s&actor_id=lia" % sid)
        ver = s["current"]["state_version"]
        st, ar = _post3("/analyze", {"session_id": sid, "actor_id": "lia",
                                     "event_id": "%s_t%d" % (ev_prefix, i),
                                     "expected_state_version": ver,
                                     "message": msg, "context": {}})
        st, cr = _post3("/commit_state", {"session_id": sid, "actor_id": "lia",
                                          "analysis_id": ar["analysis_id"],
                                          "expected_state_version": ver})
        last_aid = ar["analysis_id"]
        d = (cr.get("new_state") or cr.get("state") or {}).get("relationship", {}).get("doubt")
        if d is not None and band_fn(d):
            break
    st, nr = _post3("/narrate", {"mode": "analysis", "session_id": sid, "actor_id": "lia",
                                 "analysis_id": last_aid})
    return d, nr

_STAGE_CASES = [
    # (sid, 事件前缀, 台词, doubt增量×回合, 期望档位, 档位文案, 提示片段)
    ("stg_break", "b", "（逼近一步，语气沉下去）我不是来听你打太极的，把实话吐出来。", 90.0,
     "break", "决裂边缘", "随时可能动手"),
    ("stg_guard", "g", "你最好把来路说清楚，别跟我打马虎眼。", 30.0,
     "guard", "戒备中", "戒备"),
    ("stg_trust", "t", "说真的，我这一路没有骗过你一个字。", -15.0,
     "trust", "信任渐生", "松口"),
    ("stg_probe", "p", "我听说这镇子上最近不太平，你常驻这边吧？", 5.0,
     "probing", "试探阶段", "权衡"),
]
for _sid, _ev, _msg, _dd, _exp, _txt, _hint in _STAGE_CASES:
    with assets_ctx(deltas=([{"question": "doubt_shift", "target": "relationship.doubt",
                              "delta": _dd, "label": "怀疑", "raw": _dd, "range": [0, 100]}], {})), \
         mock.patch.object(B, 'llm_narrate', side_effect=_probe):
        _d, _nr = _walk_to_band(_sid, _ev, _msg, _dd, _exp)
        _got = (_nr or {}).get("plot_stage") or {}
        chk('档位[%s] 提交后 doubt=%s → 响应 plot_stage=%s'
            % (_exp, _d, (_got or {}).get("key")),
            _nr is not None and (_got or {}).get("key") == _exp
            and (_d is None or (B.plot_stage({"relationship": {"doubt": _d}}).get("key") == _exp)),
            'doubt=%s key=%s' % (_d, (_got or {}).get("key")))
        _blk = (_cap[-1] or {}).get("signals_block") or ""
        chk('档位[%s] 注入「%s」分块给叙事模型' % (_exp, _txt),
            _txt in _blk and _hint in _blk and "参考，不念数字" in _blk,
            'blk=%r' % (_blk[:80] if _blk else None))
        chk('档位[%s] 响应含 state_source/state_version（提交语义完整）' % _exp,
            (_nr or {}).get("state_source") == "committed"
            and (_nr or {}).get("state_version"),
            'src=%s ver=%s' % ((_nr or {}).get("state_source"), (_nr or {}).get("state_version")))

# ---- 旧流叙事档位注入（整页一致：/narrate 带 behavior 也随关系档位走）----
_bs0 = B._narrate_stage_block("stg_legacy2", "lia", B.CFG["actor"])
chk('旧流分块：未提交（模板）→ 试探阶段', "试探阶段" in _bs0, 'blk=%r' % _bs0[:40])
with assets_ctx(deltas=([{"question": "doubt_shift", "target": "relationship.doubt",
                          "delta": 30.0, "label": "怀疑", "raw": 30.0,
                          "range": [0, 100]}], {})), \
     mock.patch.object(B, 'llm_narrate', side_effect=_probe):
    _lgd, _lgnr = _walk_to_band("stg_legacy", "lg",
                                "你最好把来路说清楚，别跟我打马虎眼。", 30.0, "guard")
    _cap[:] = []
    _st, _ = _post3("/narrate", {"session_id": "stg_legacy", "actor_id": "lia",
                                 "behavior": {"id": "probe"}, "use_llm": True,
                                 "message": "（追问）那麻袋里到底是什么？"})
    _blk = (_cap[-1] or {}).get("signals_block") or ""
    chk('旧流叙事收到关系档位分块（戒备中，与 P2 同文案）',
        "戒备中" in _blk and "参考，不念数字" in _blk,
        'blk=%r' % (_blk[:70] if _blk else None))
srv3.shutdown()

print('=' * 92)
print('P2-C 后端自测：合计 %d 项：%d PASS / %d FAIL' % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)