"""P2-B2 旧路由事务/版本适配自测（秒级：零模型、mock 翻译/档案、fallback 引擎）。

覆盖《P2-A-Analyze-Commit协议.md》§9 的 L1 与 §6.3：
  L1-1  /decide → /commit(turn_id) 与 /commit_state 共用版本体系：
        旧提交成功后，基于旧版本的新分析 → STATE_VERSION_CONFLICT
  L1-2  反向：新提交推进版本后，旧 Pending 的 /commit → stale
  L1-3  legacy 特例：有行为但无 writable → 接受行为历史 + 推进版本 + 状态不变
  L1-4  ambiguous Pending（无行为）→ /commit 拒绝且零写入
  L1-5  Reset 锁内换 generation：旧 Pending / 旧候选 / 旧版本全部作废
  L1-6  同版本两个旧 Pending 并发 /commit → 仅一个成功
  L1-7  HTTP：/turn commit_state=false 零写入零版本；旧 /commit stale 409；/reset 换 generation

★ 统一使用 bridge 全局 `B.PROTOCOL`（旧路由 propose/commit 与之同实例），
  避免测试自建实例造成版本体系分裂。
"""
import copy
import json
import sys
import threading
import time
from contextlib import contextmanager
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_state_protocol import _ProtoError

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


now = [1000.0]
P = B.PROTOCOL
P.now = lambda: now[0]   # 假时钟注入 bridge 全局协议实例

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
    for tid in list(B._PENDING):
        B._PENDING.pop(tid, None)
    P._buckets.clear()
    P._analyses.clear()
    P._events.clear()
    P._inflight.clear()
    now[0] = 1000.0


@contextmanager
def assets_ctx(deltas=None, engine_ready=True):
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: _lcp(m, FAKE_PROF, None)), \
         mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: copy.deepcopy(deltas if deltas is not None else FD_DELTAS)), \
         mock.patch.object(B, '_cached_translate', return_value='EN'), \
         mock.patch.object(B, '_engine_identity',
                           return_value={"ready": engine_ready, "model_name": "typed-decisions",
                                         "detail": "stub"}):
        yield


def manual_pending(sid, aid, tid="m1", behavior="approach", with_delta=True):
    """确定性构造一个「有行为」的旧 Pending（不依赖 fallback 是否歧义）。返回 turn_id。"""
    sp = {"delta": [{"source_signal": "doubt_shift", "target": "relationship.doubt",
                     "delta": 3.0, "status": "active", "grade": "A",
                     "role": "state_shift", "label": "怀疑", "range": [0, 100]}]} \
        if with_delta else {"delta": []}
    B.propose_turn(tid, sid, aid, behavior, "engage", "policy",
                   state_proposal=sp,
                   state_decision={"behavior_is_null": False,
                                   "awaiting_upstream": False,
                                   "source": "policy", "turn_id": tid},
                   actor=None)
    return tid


def run_real_decide(sid, aid):
    """真实旧 /decide 冒烟：登记 Pending；若引擎判歧义则记录、不硬断言提交。"""
    out = B.decide({"session_id": sid, "actor_id": aid, "player_input": "你好，我需要一个答复。",
                    "player_input_en": "EN", "history": []})
    turn = out.get("turn") or {}
    dec = out.get("decision") or {}
    beh = dec.get("behavior") or {}
    B.propose_turn(turn.get("turn_id"), turn.get("session_id"), turn.get("actor_id"),
                   beh.get("id"), (dec.get("player_intent") or {}).get("id"),
                   dec.get("source"), state_proposal=out.get("state_proposal"),
                   state_decision=(out.get("state_validation") or {}).get("decision"), actor=None)
    return out, bool(beh.get("id"))


print('=' * 92)
print('P2-B2 旧路由事务/版本适配自测（零模型 / 假时钟 / mock）')
print('=' * 92)

# ===========================================================================
print("\n[L1-1] 旧提交推进版本 → 基于旧版本的新分析被拒（STATE_VERSION_CONFLICT）")
# ===========================================================================
reset_all()
with assets_ctx():
    _real_out, _has_bh = run_real_decide("s1", "lia")
    chk('L1-1 真实 /decide 走通并登记 Pending（是否歧义由引擎裁决）',
        _real_out.get("turn", {}).get("turn_id") is not None, '')
    keep_tid = _real_out["turn"]["turn_id"]
    B._PENDING.pop(keep_tid, None)   # 真实轮只做冒烟，下面的机制验证用手工 Pending
    v0 = P.state_version(("s1", "lia"))
    tid = manual_pending("s1", "lia", tid="L1a")
    chk('L1-1 旧 Pending 绑定登记版本', B._PENDING[tid]["base_state_version"] == v0, '')
    ok, note, res = B.commit_turn(tid)
    chk('L1-1 旧 /commit 成功且推进版本', ok and res["state_version"] != v0
        and res["stage"] == "committed", 'ok=%s ver=%s note=%s' % (ok, res.get("state_version"), note[:40]))
    chk('L1-1 旧提交后状态 33',
        res.get("actor_state", {}).get("state", {}).get("relationship", {}).get("doubt") == 33,
        'doubt=%s' % res.get("actor_state", {}).get("state", {}).get("relationship", {}).get("doubt"))
    try:
        P.analyze({"session_id": "s1", "actor_id": "lia", "event_id": "ev_new",
                   "expected_state_version": v0, "message": "你变了。", "context": {}})
        chk('L1-1 旧版本新分析被拒', False, '')
    except _ProtoError as e:
        chk('L1-1 旧提交后旧版本新分析 → STATE_VERSION_CONFLICT',
            e.code == "STATE_VERSION_CONFLICT", 'code=%s' % e.code)

# ===========================================================================
print("\n[L1-2] 新提交推进版本 → 旧 Pending 的 /commit 变 stale")
# ===========================================================================
reset_all()
with assets_ctx():
    tid = manual_pending("s1", "lia", tid="L2a")
    base0 = B._PENDING[tid]["base_state_version"]
    r = P.analyze({"session_id": "s1", "actor_id": "lia", "event_id": "ev_a",
                   "expected_state_version": base0, "message": "我先来。", "context": {}})
    P.commit_state({"session_id": "s1", "actor_id": "lia", "analysis_id": r["analysis_id"],
                    "expected_state_version": base0})
    ok, note, res = B.commit_turn(tid)
    chk('L1-2 新提交后旧 Pending 提交被拒（stale）', not ok and res.get("reason") == "stale_state_version",
        'ok=%s reason=%s' % (ok, res.get("reason")))
    chk('L1-2 stale 后未再推进版本', res.get("current") == P.state_version(("s1", "lia")), '')

# ===========================================================================
print("\n[L1-3] legacy 特例：有行为但无 writable → 行为历史 + 版本推进 + 状态不变")
# ===========================================================================
reset_all()
with assets_ctx():
    v0 = P.state_version(("s1", "lia"))
    tid = manual_pending("s1", "lia", tid="L3a", with_delta=False)
    ok, note, res = B.commit_turn(tid)
    chk('L1-3 legacy 提交成功（无状态项）', ok and res["stage"] == "committed", 'ok=%s' % ok)
    chk('L1-3 legacy 状态未创建（无 writable）', ("s1", "lia") not in B._ACTOR_STATE, '')
    chk('L1-3 legacy 仍推进一次版本', res["state_version"] != v0, '')
    chk('L1-3 legacy 声明行为历史（history_entries=2）', res.get("history_entries") == 2,
        'entries=%s' % res.get("history_entries"))

# ===========================================================================
print("\n[L1-4] ambiguous Pending（无行为）→ /commit 拒绝且零写入")
# ===========================================================================
reset_all()
with assets_ctx():
    v0 = P.state_version(("s1", "lia"))
    B.propose_turn("amb1", "s1", "lia", None, None, "ambiguous",
                   state_proposal={}, state_decision={"behavior_is_null": True,
                                                      "awaiting_upstream": True}, actor=None)
    ok, note, res = B.commit_turn("amb1")
    chk('L1-4 ambiguous 提交被拒', not ok and res.get("reason") == "no_behavior", 'ok=%s' % ok)
    chk('L1-4 ambiguous 零写入零推进', ("s1", "lia") not in B._ACTOR_STATE
        and not B._HISTORY_BUCKETS and P.state_version(("s1", "lia")) == v0, '')

# ===========================================================================
print("\n[L1-5] Reset 锁内换 generation：旧 Pending / 旧候选 / 旧版本全部作废")
# ===========================================================================
reset_all()
with assets_ctx():
    tid = manual_pending("s1", "lia", tid="L5a")
    old_ver = P.state_version(("s1", "lia"))
    with P.lock:
        new_ver = P.reset_scope(("s1", "lia"))
        B.reset_history("s1", "lia")
        B.reset_actor_state("s1", "lia")
        B._PENDING.pop(tid, None)
    chk('L1-5 Reset 更换 generation', new_ver != old_ver and ":1:" in new_ver and ":0:" in old_ver,
        'old=%s new=%s' % (old_ver, new_ver))
    ok, note, res = B.commit_turn(tid)
    chk('L1-5 Reset 后旧 Pending 不可提交', not ok, 'ok=%s reason=%s' % (ok, res.get("reason")))
    try:
        P.analyze({"session_id": "s1", "actor_id": "lia", "event_id": "ev_after",
                   "expected_state_version": old_ver, "message": "重置之后", "context": {}})
        chk('L1-5 Reset 后旧版本 analyze 被拒', False, '')
    except _ProtoError as e:
        chk('L1-5 Reset 后旧版本 analyze → STATE_VERSION_CONFLICT',
            e.code == "STATE_VERSION_CONFLICT", 'code=%s' % e.code)

# ===========================================================================
print("\n[L1-6] 同版本两个旧 Pending 并发 /commit → 仅一个成功")
# ===========================================================================
reset_all()
with assets_ctx():
    manual_pending("s1", "lia", tid="L6a")
    manual_pending("s1", "lia", tid="L6b")
    v0 = P.state_version(("s1", "lia"))
    res = [None, None]

    def c1():
        res[0] = B.commit_turn("L6a")

    def c2():
        res[1] = B.commit_turn("L6b")

    th = [threading.Thread(target=c1), threading.Thread(target=c2)]
    [t.start() for t in th]
    [t.join() for t in th]
    ok_n = sum(1 for x in res if x[0])
    stale_n = sum(1 for x in res if not x[0] and x[2].get("reason") == "stale_state_version")
    chk('L1-6 同版本并发旧提交只一个成功', ok_n == 1 and stale_n == 1,
        'ok=%d stale=%d' % (ok_n, stale_n))
    chk('L1-6 并发后只应用一次（doubt=33）',
        B._ACTOR_STATE.get(("s1", "lia"), {}).get("relationship", {}).get("doubt") == 33
        and P.state_version(("s1", "lia")) != v0, 'doubt=%s'
        % B._ACTOR_STATE.get(("s1", "lia"), {}).get("relationship", {}).get("doubt"))

# ===========================================================================
print("\n[L1-7] HTTP 路由：/turn false 零写入；旧 /commit stale 409；/reset 换 generation")
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


with assets_ctx():
    ver0 = P.state_version(("demo_01", "lia"))
    st, t_res = _post("/turn", {"session_id": "demo_01", "actor_id": "lia",
                                "player_input": "商量一下。", "player_input_en": "EN",
                                "history": [], "commit_state": False})
    chk('L1-7 /turn false 返回 not_committed',
        st == 200 and t_res.get("state_gate", {}).get("stage") == "not_committed", 'st=%s' % st)
    chk('L1-7 /turn false 零状态/历史/版本',
        ("demo_01", "lia") not in B._ACTOR_STATE and not B._HISTORY_BUCKETS
        and P.state_version(("demo_01", "lia")) == ver0, '')
    # 有行为的旧 Pending + 新协议提交推版本 → 旧 /commit stale 409（确定性场景）
    base1 = P.state_version(("demo_01", "lia"))
    manual_pending("demo_01", "lia", tid="L7m")
    r = P.analyze({"session_id": "demo_01", "actor_id": "lia", "event_id": "h2",
                   "expected_state_version": base1, "message": "我来推进版本。", "context": {}})
    P.commit_state({"session_id": "demo_01", "actor_id": "lia", "analysis_id": r["analysis_id"],
                    "expected_state_version": base1})
    st, cm = _post("/commit", {"turn_id": "L7m"})
    chk('L1-7 新提交后旧 /commit → 409 + reason',
        st == 409 and cm.get("reason") == "stale_state_version" and cm.get("stage") == "rejected",
        'st=%s reason=%s' % (st, cm.get("reason")))
    st, rset = _post("/reset", {"session_id": "demo_01", "actor_id": "lia"})
    chk('L1-7 /reset 换 generation', st == 200 and rset.get("state_version")
        and ":1:" in rset["state_version"], 'ver=%s' % rset.get("state_version"))
srv.shutdown()

print('=' * 92)
print('P2-B2 旧路由事务/版本自测：合计 %d 项：%d PASS / %d FAIL'
      % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)