"""P2-B1 协议服务单元自测（秒级：零模型、零云端、假时钟、临时 HTTP 端口）。

覆盖《P2-A-Analyze-Commit协议.md》§9 验收矩阵的协议层（A1–A5、C1–C6）；
L1（旧路由共用事务边界）属于 P2-B2，不在这里。
引擎走 fallback（ENGINE 未 init → ready=False，零模型）；翻译/档案/deltas 全 mock；
TTL 用假时钟；并发用线程。HTTP 路由层用本机临时端口。

★ 运行环境（S-5，2026-09-25）：Windows 控制台默认 GBK 编不出来 ✅，会第一行就崩——
  请用 `PYTHONIOENCODING=utf-8 python tests/p2b1_unit.py` 运行。
"""
import copy
import json
import sys
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_state_protocol as SP
from laya_state_protocol import LayaStateProtocol, _ProtoError

FAIL = []
N = [0]


def chk(tag, ok, detail=''):
    N[0] += 1
    print('  %s [%s] %s' % ('✅' if ok else '❌', tag, detail))
    if not ok:
        FAIL.append(tag)


FAKE_CHECK = {"matched": True, "fresh": True, "problems": [],
              "code_changed": True, "checkpoint": "typed-decisions", "profile_id": "fp_t"}
FAKE_PROF = {"checkpoint": "typed-decisions", "profile_id": "fp_t", "signals": {
    "doubt_shift": {"grade": "A", "status": "active", "role": "state_shift"},
    "trust_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
    "fondness_shift": {"grade": "C", "status": "auxiliary", "role": "state_shift"},
    "respect_shift": {"grade": "D", "status": "disabled", "role": "state_shift"},
    "alert_shift": {"grade": "D", "status": "disabled", "role": "state_shift"},
    "goal_shift": {"grade": "D", "status": "disabled", "role": "state_shift"},
}}
FAKE_DELTAS = ([
    {"question": "doubt_shift", "target": "relationship.doubt", "delta": 3.0,
     "label": "怀疑", "raw": 2.4, "range": [0, 100]},
    {"question": "trust_shift", "target": "relationship.trust", "delta": 2.0,
     "label": "信任", "raw": 1.5, "range": [0, 100]},
], {})


def _lcp(model, prof=None, check=None):
    if prof is None:
        return None, dict(check or FAKE_CHECK)
    return copy.deepcopy(prof), dict(check or FAKE_CHECK)


def _bd(answers, qs, actor, deltas=None):
    return copy.deepcopy(deltas if deltas is not None else FAKE_DELTAS)


now = [1000.0]
P = LayaStateProtocol(B, now=lambda: now[0])


def reset_all():
    B.reset_actor_state()
    B.reset_history()
    P._buckets.clear()
    P._analyses.clear()
    P._events.clear()
    P._inflight.clear()
    now[0] = 1000.0


@contextmanager
def assets_ctx(profile=None, check=None, deltas=None, xlate="EN_TEST", engine_ready=True,
               engine_model="typed-decisions"):
    use_prof = FAKE_PROF if profile is None else profile
    eng = {"ready": engine_ready, "model_name": engine_model, "detail": "stub"}
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: _lcp(m, use_prof, check)), \
         mock.patch.object(B, 'load_capability_profiles',
                           return_value={"profiles": {}}), \
         mock.patch.object(B, 'build_deltas',
                           side_effect=lambda a, q, ac: _bd(a, q, ac, deltas)), \
         mock.patch.object(B, '_cached_translate', return_value=xlate), \
         mock.patch.object(B, '_engine_identity', return_value=eng):
        yield


def base_req(event="ev1", message="你一直在瞒着我什么？", expected=None, ctx=None):
    return {
        "session_id": "demo_01", "actor_id": "lia",
        "event_id": event, "message": message,
        "expected_state_version": expected or P.state_version(("demo_01", "lia")),
        "context": ctx or {"scene": "旅店大厅", "history": []},
    }


print('=' * 92)
print('P2-B1 协议服务单元自测（零模型 / 假时钟 / mock 翻译·档案）')
print('=' * 92)

# ===========================================================================
print("\n[A1] Analyze/查询不创建 Actor State / 历史 / trace；捕获快照一致")
# ===========================================================================
reset_all()
with assets_ctx():
    st0 = B.actor_state_view('demo_01', 'lia')
    chk('A1 分析前无 Actor State 桶', st0["exists"] is False, '')
    r = P.analyze(base_req())
    aid = r["analysis_id"]
    chk('A1 analyze 返回 ready', r["status"] == "ready" and r["can_commit"] is True,
        'status=%s can_commit=%s' % (r["status"], r["can_commit"]))
    v = B.actor_state_view('demo_01', 'lia')
    chk('A1 analyze 后仍无 Actor State 桶', v["exists"] is False, '')
    chk('A1 analyze 不写已提交历史', not B._HISTORY_BUCKETS, 'buckets=%d' % len(B._HISTORY_BUCKETS))
    chk('A1 analyze 不写 trace', not B._STATE_TRACE, 'trace=%d' % len(B._STATE_TRACE))
    q = P.get_analysis(aid, 'demo_01', 'lia')
    chk('A1 查询后仍无桶/历史/trace', v["exists"] is False and not B._HISTORY_BUCKETS
        and not B._STATE_TRACE, '')
    chk('A1 捕获快照哈希一致', r["evidence"]["base_state_sha256"] == q["evidence"]["base_state_sha256"],
        '')
    # 捕获快照 == 模板默认（未初始化）
    snap = B.actor_state_snapshot('demo_01', 'lia', actor=B.CFG.get("actor"))
    chk('A1 基准快照是模板（未初始化）', r["evidence"]["base_state_sha256"]
        == SP._sha256_text(snap), '')

# ===========================================================================
print("\n[A2] 同事件同版本重试复用 ID；并发只推理一次；不同事件同文本不去重")
# ===========================================================================
reset_all()
with assets_ctx():
    r1 = P.analyze(base_req())
    r2 = P.analyze(base_req())
    chk('A2 同事件同版本重试复用同一 ID', r1["analysis_id"] == r2["analysis_id"], '')
    chk('A2 复用候选不重新推理（状态/证据一致）',
        r1["evidence"]["input_sha256"] == r2["evidence"]["input_sha256"], '')
    # 并发：T1 进入慢 analyze_core，T2 同 event+base → 409 ANALYSIS_IN_PROGRESS
    reset_all()
    orig_core = B.analyze_core
    entered = threading.Event()
    calls = [0]

    def slow_core(*a, **k):
        calls[0] += 1
        entered.set()
        time.sleep(0.3)
        return orig_core(*a, **k)

    with assets_ctx(), mock.patch.object(B, 'analyze_core', side_effect=slow_core):
        out = [None, None]

        def t1():
            try:
                out[0] = P.analyze(base_req())
            except _ProtoError as e:
                out[0] = {"error": {"code": e.code}}

        def t2():
            try:
                out[1] = P.analyze(base_req())
            except _ProtoError as e:
                out[1] = {"error": {"code": e.code}}
            except Exception as e:
                out[1] = {"error": {"code": type(e).__name__, "msg": str(e)[:120]}}

        th = [threading.Thread(target=t1), threading.Thread(target=t2)]
        [t.start() for t in th]
        [t.join() for t in th]
    ok_n = sum(1 for x in out if isinstance(x, dict) and x.get("analysis_id"))
    inprog_n = sum(1 for x in out if isinstance(x, dict)
                   and (x.get("error") or {}).get("code") == "ANALYSIS_IN_PROGRESS")
    chk('A2 并发：恰好一个成功一个 ANALYSIS_IN_PROGRESS',
        ok_n == 1 and inprog_n == 1, 'ok=%d inprog=%d' % (ok_n, inprog_n))
    chk('A2 并发只推理一次', calls[0] == 1, 'calls=%d' % calls[0])
    # 不同事件同文本 → 两个不同 ID（不做全局文本去重）
    reset_all()
    with assets_ctx():
        a1 = P.analyze(base_req(event="e_other_1"))
        a2 = P.analyze(base_req(event="e_other_2"))
        chk('A2 不同事件同文本生成两个候选', a1["analysis_id"] != a2["analysis_id"], '')

# ===========================================================================
print("\n[A3] 只 active state_shift 可写；auxiliary/disabled/未知/NaN 不写")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    wd = (r["state_proposal"] or {}).get("writable_delta") or []
    aux = (r["state_proposal"] or {}).get("auxiliary") or []
    chk('A3 writable 只有 doubt_shift', [w["source_signal"] for w in wd] == ["doubt_shift"],
        'wd=%s' % [w["source_signal"] for w in wd])
    chk('A3 trust_shift 进 auxiliary（不写）', [a["source_signal"] for a in aux] == ["trust_shift"],
        'aux=%s' % [a["source_signal"] for a in aux])
    # 死区内/未出值信号不产生 writable：deltas 里 doubt_shift delta=None
    bad_deltas = (copy.deepcopy(FAKE_DELTAS[0])[:1], {})
    bad_deltas[0][0]["delta"] = None
    with assets_ctx(deltas=bad_deltas):
        rb = P.analyze(base_req(event="ev_nan"))
        wb = (rb["state_proposal"] or {}).get("writable_delta") or []
        sb = (rb["state_proposal"] or {}).get("skipped") or []
        chk('A3 数值缺失（None）不进 writable', not wb, 'wb=%d' % len(wb))
        chk('A3 数值缺失进入 skipped 且 reason 含 UNKNOWN_VALUE',
            any("UNKNOWN_VALUE" in (s.get("reason_codes") or []) for s in sb),
            'sb=%s' % [[s.get("source_signal"), s.get("reason_codes")] for s in sb])

# ===========================================================================
print("\n[A4] judgment 模式可合法提交（不需要 NPC 行为）；旧歧义门仍拒")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    # fallback 引擎下 analyze_core 的旧 state_decision 可能是 behavior_is_null，
    # 协议层用 judgment 语义重验 → 仍可提交
    commit = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                             "analysis_id": r["analysis_id"],
                             "expected_state_version": r["base_state_version"]})
    chk('A4 judgment 提交成功', commit["status"] == "committed", 'status=%s' % commit["status"])
    # 旧歧义门仍存在：validate_state_delta 对 behavior_is_null 全 skip
    reset_all()
    snap = B.actor_state_snapshot('demo_01', 'lia', actor=B.CFG.get("actor"))
    vd, sk, pv = B.validate_state_delta(
        'demo_01', 'lia', {"delta": [{"source_signal": "doubt_shift", "target": "relationship.doubt",
                                      "delta": 3.0, "status": "active"}]},
        {"behavior_is_null": True, "awaiting_upstream": True}, actor=B.CFG.get("actor"),
        frozen_state=snap)
    chk('A4 旧 ambiguous/upstream 仍不提交状态', not vd and len(sk) >= 1, 'vd=%d sk=%d' % (len(vd), len(sk)))

# ===========================================================================
print("\n[A5] 死区零值合法提交一次并推进版本；reference_only 不伪装成功")
# ===========================================================================
reset_all()
zero_deltas = ([copy.deepcopy(FAKE_DELTAS[0][0])], {})
zero_deltas[0][0]["delta"] = 0.3   # 死区 1.0 内 → final_delta=0
with assets_ctx(deltas=zero_deltas):
    r = P.analyze(base_req(event="ev_zero"))
    chk('A5 死区零值仍 ready/can_commit', r["status"] == "ready" and r["can_commit"] is True,
        'status=%s' % r["status"])
    v0 = P.state_version(("demo_01", "lia"))
    c = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
    chk('A5 零值合法提交（committed）', c["status"] == "committed", '')
    chk('A5 零值 state_changed=false', c["state_changed"] is False, 'changed=%s' % c["state_changed"])
    v1 = P.state_version(("demo_01", "lia"))
    chk('A5 零值提交也推进一次版本', v0 != v1, '%s -> %s' % (v0, v1))
    chk('A5 零值提交后 doubt 不变', c["state"]["relationship"]["doubt"] == 30, 'doubt=%s'
        % c["state"]["relationship"]["doubt"])
# reference_only：档案不可用（独立 mock，避免 assets_ctx 默认 FAKE_PROF）
reset_all()
with mock.patch.object(B, 'load_capability_profile',
                       side_effect=lambda m: (None, {"matched": False, "fresh": False,
                                                     "problems": ["档案缺失"], "code_changed": False,
                                                     "checkpoint": "typed-decisions", "profile_id": None})), \
     mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}), \
     mock.patch.object(B, 'build_deltas', side_effect=lambda a, q, ac: _bd(a, q, ac)), \
     mock.patch.object(B, '_cached_translate', return_value="EN"), \
     mock.patch.object(B, '_engine_identity', return_value={"ready": True,
                                                            "model_name": "typed-decisions",
                                                            "detail": "stub"}):
    r = P.analyze(base_req(event="ev_ref"))
    chk('A5 档案不可用 → reference_only/can_commit=false',
        r["status"] == "reference_only" and r["can_commit"] is False,
        'status=%s can=%s reason=%s' % (r["status"], r["can_commit"], r.get("reason_codes")))
    try:
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('A5 reference_only 提交被拒', False, '应抛错误')
    except _ProtoError as e:
        chk('A5 reference_only 不允许空 Commit 冒充成功',
            e.code in ("ANALYSIS_NOT_COMMITTABLE", "PROFILE_UNAVAILABLE"), 'code=%s' % e.code)

# ===========================================================================
print("\n[C1] 首次提交更新快照/审计/版本/回执；下一轮读新状态；不串桶")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    c = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
    chk('C1 首次提交建立 Actor State 桶', ("demo_01", "lia") in B._ACTOR_STATE, '')
    chk('C1 doubt 更新到 33', abs(c["state"]["relationship"]["doubt"] - 33) < 1e-9,
        'doubt=%s' % c["state"]["relationship"]["doubt"])
    chk('C1 版本推进', c["state_version"] != c["previous_state_version"], '')
    chk('C1 审计写入 accepted_interaction',
        B._STATE_TRACE.get(("demo_01", "lia"))
        and B._STATE_TRACE[("demo_01", "lia")][-1]["kind"] == "accepted_interaction", '')
    st = P.get_state('demo_01', 'lia')
    chk('C1 下一轮 GET /state 读到新值', st["current"]["state"]["relationship"]["doubt"] == 33
        and st["current"]["source"] == "committed", 'source=%s' % st["current"]["source"])
    # 另一角色不串桶
    ren_ver = P.state_version(("demo_01", "ren"))
    r2 = P.analyze({"session_id": "demo_01", "actor_id": "ren", "event_id": "ev2",
                    "message": "你又是谁？", "expected_state_version": ren_ver, "context": {}})
    c2 = P.commit_state({"session_id": "demo_01", "actor_id": "ren",
                         "analysis_id": r2["analysis_id"],
                         "expected_state_version": r2["base_state_version"]})
    chk('C1 ren 自己 +3（独立桶）', c2["state"]["relationship"]["doubt"] == 33, 'doubt=%s'
        % c2["state"]["relationship"]["doubt"])
    chk('C1 lia 桶不受 ren 提交影响', B._ACTOR_STATE[("demo_01", "lia")]["relationship"]["doubt"] == 33
        and B._ACTOR_STATE[("demo_01", "ren")]["relationship"]["doubt"] == 33
        and len(B._ACTOR_STATE) == 2, 'lia=%s' % B._ACTOR_STATE[("demo_01", "lia")]["relationship"]["doubt"])

# ===========================================================================
print("\n[C2] 同 ID 并发只写一次；同事件只接受一次；同版本两事件只一个成功")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    out = [None, None]
    base = r["base_state_version"]

    def c1():
        out[0] = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                                 "analysis_id": r["analysis_id"],
                                 "expected_state_version": base})

    def c2():
        out[1] = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                                 "analysis_id": r["analysis_id"],
                                 "expected_state_version": base})

    th = [threading.Thread(target=c1), threading.Thread(target=c2)]
    [t.start() for t in th]
    [t.join() for t in th]
    replay = [x for x in out if x and x.get("replayed") is True]
    first = [x for x in out if x and x.get("replayed") is False]
    chk('C2 同 ID 并发：一个首次一个回放', len(first) == 1 and len(replay) == 1,
        'first=%d replay=%d' % (len(first), len(replay)))
    chk('C2 只写一次（版本只推进 1）', P.state_version(("demo_01", "lia")) == first[0]["state_version"], '')
    chk('C2 doubt 最终 33', B._ACTOR_STATE[("demo_01", "lia")]["relationship"]["doubt"] == 33, '')
    # 同事件已 committed → 再 analyze 同 event 409 EVENT_ALREADY_COMMITTED
    try:
        P.analyze(base_req())
        chk('C2 committed 后同 event 分析被拒', False, '应 409')
    except _ProtoError as e:
        chk('C2 committed 后同 event → EVENT_ALREADY_COMMITTED',
            e.code == "EVENT_ALREADY_COMMITTED", 'code=%s' % e.code)
# 两不同事件同版本 → 只一个成功
reset_all()
with assets_ctx():
    a1 = P.analyze(base_req(event="e_a"))
    a2 = P.analyze(base_req(event="e_b"))
    base = a1["base_state_version"]
    okn = 0
    for a in (a1, a2):
        try:
            P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                            "analysis_id": a["analysis_id"],
                            "expected_state_version": base})
            okn += 1
        except _ProtoError:
            pass
    chk('C2 两个不同事件同版本只一个成功', okn == 1, 'ok=%d' % okn)

# ===========================================================================
print("\n[C3] 原请求重试得原回执；换字段/版本拒绝；scope 不符 404")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    c1 = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                         "analysis_id": r["analysis_id"],
                         "expected_state_version": r["base_state_version"]})
    c2 = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                         "analysis_id": r["analysis_id"],
                         "expected_state_version": r["base_state_version"]})
    chk('C3 原请求重试 → replayed=true 原回执',
        c2["replayed"] is True and c2["commit_id"] == c1["commit_id"]
        and c2["state_version"] == c1["state_version"], '')
    chk('C3 重试不重复写（版本不变）',
        P.state_version(("demo_01", "lia")) == c1["state_version"], '')
    # 换 expected → IDEMPOTENCY_CONFLICT
    try:
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": "v1:other:0:0"})
        chk('C3 换 expected 被拒', False, '')
    except _ProtoError as e:
        chk('C3 committed 换 expected → IDEMPOTENCY_CONFLICT',
            e.code == "IDEMPOTENCY_CONFLICT", 'code=%s' % e.code)
    # 换 scope → 404
    try:
        P.commit_state({"session_id": "other", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('C3 换 scope 被拒', False, '')
    except _ProtoError as e:
        chk('C3 scope 不符 → 404 ANALYSIS_NOT_FOUND', e.code == "ANALYSIS_NOT_FOUND", 'code=%s' % e.code)
    # 已有后续版本时旧 expected 重试：协议 §3.4 允许回执保留期内返回原回执（replayed）
    r3 = P.analyze(base_req(event="e3", expected=P.state_version(("demo_01", "lia"))))
    P.commit_state({"session_id": "demo_01", "actor_id": "lia", "analysis_id": r3["analysis_id"],
                    "expected_state_version": r3["base_state_version"]})
    c_old = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                            "analysis_id": r["analysis_id"],
                            "expected_state_version": c1["previous_state_version"]})
    chk('C3 旧版本重试返回原回执（replayed=true，不重写）',
        c_old["replayed"] is True and c_old["commit_id"] == c1["commit_id"]
        and P.state_version(("demo_01", "lia")) != c_old["state_version"], '')

# ===========================================================================
print("\n[C4] profile 内容变化（含保持 mtime）拒绝；仅 code_changed 不升降")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    # 档案内容变化（保持 mock 的 mtime 语义：force 读取返回新内容）
    new_prof = copy.deepcopy(FAKE_PROF)
    new_prof["signals"]["doubt_shift"]["grade"] = "C"
    new_prof["signals"]["doubt_shift"]["status"] = "auxiliary"
    with mock.patch.object(B, 'load_capability_profile',
                           side_effect=lambda m: _lcp(m, new_prof, FAKE_CHECK)), \
         mock.patch.object(B, 'load_capability_profiles', return_value={"profiles": {}}):
        try:
            P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                            "analysis_id": r["analysis_id"],
                            "expected_state_version": r["base_state_version"]})
            chk('C4 档案内容变化被拒', False, '')
        except _ProtoError as e:
            chk('C4 profile 内容变化 → RULESET_CHANGED', e.code == "RULESET_CHANGED", 'code=%s' % e.code)
    chk('C4 拒绝后无状态写入', not B._ACTOR_STATE, '')
# 仅 code_changed 不拒绝（fresh/matched 不变即可提交）
reset_all()
with assets_ctx(check={"matched": True, "fresh": True, "problems": [], "code_changed": True,
                        "checkpoint": "typed-decisions", "profile_id": "fp_t"}):
    r = P.analyze(base_req())
    c = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
    chk('C4 仅 code_changed=true 不阻止提交', c["status"] == "committed", 'status=%s' % c["status"])

# ===========================================================================
print("\n[C5] TTL 临界 / Reject / 容量满 / Reset / 回执清理 / 事件墓碑")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    # TTL 临界：now+599 仍 ready；now+600 → expired
    now[0] += 599
    q = P.get_analysis(r["analysis_id"], 'demo_01', 'lia')
    chk('C5 TTL 内仍可查询（ready）', q["status"] == "ready", 'status=%s' % q["status"])
    now[0] += 2   # 601s 总
    q = P.get_analysis(r["analysis_id"], 'demo_01', 'lia')
    chk('C5 超过 600s → expired', q["status"] == "expired", 'status=%s' % q["status"])
    try:
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('C5 expired 提交被拒', False, '')
    except _ProtoError as e:
        chk('C5 expired → 410 ANALYSIS_EXPIRED', e.code == "ANALYSIS_EXPIRED", 'code=%s' % e.code)
    # Reject
    reset_all()
    now[0] = 1000.0
    r = P.analyze(base_req())
    rr = P.reject_analysis({"session_id": "demo_01", "actor_id": "lia",
                            "analysis_id": r["analysis_id"], "reason": "user_cancelled"})
    chk('C5 reject 成功', rr["status"] == "rejected" and rr["replayed"] is False, '')
    rr2 = P.reject_analysis({"session_id": "demo_01", "actor_id": "lia",
                             "analysis_id": r["analysis_id"], "reason": "user_cancelled"})
    chk('C5 重复 reject → replayed=true', rr2["replayed"] is True, '')
    try:
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('C5 rejected 提交被拒', False, '')
    except _ProtoError as e:
        chk('C5 rejected → 409 ANALYSIS_REJECTED', e.code == "ANALYSIS_REJECTED", 'code=%s' % e.code)
    # Reject 后同事件再分析 → EVENT_REJECTED
    try:
        P.analyze(base_req())
        chk('C5 rejected 后同 event 分析被拒', False, '')
    except _ProtoError as e:
        chk('C5 rejected 后同 event → EVENT_REJECTED', e.code == "EVENT_REJECTED", 'code=%s' % e.code)
    # committed 后 Reject → ALREADY_COMMITTED
    r2 = P.analyze(base_req(event="e_c5_ok"))
    P.commit_state({"session_id": "demo_01", "actor_id": "lia", "analysis_id": r2["analysis_id"],
                    "expected_state_version": r2["base_state_version"]})
    try:
        P.reject_analysis({"session_id": "demo_01", "actor_id": "lia",
                           "analysis_id": r2["analysis_id"]})
        chk('C5 committed 后 Reject 被拒', False, '')
    except _ProtoError as e:
        chk('C5 committed 后 Reject → ALREADY_COMMITTED', e.code == "ALREADY_COMMITTED", 'code=%s' % e.code)
    # Reset：候选 invalidated；旧版本不可重用
    reset_all()
    now[0] = 1000.0
    r = P.analyze(base_req())
    P.reset_scope(("demo_01", "lia"))
    try:
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('C5 Reset 后提交被拒', False, '')
    except _ProtoError as e:
        chk('C5 Reset 后 → 410 ANALYSIS_INVALIDATED', e.code == "ANALYSIS_INVALIDATED", 'code=%s' % e.code)
    # 回执清理：committed 后超 3600s，请求时自动清理 → 原请求重试 404（不再 replayed）
    reset_all()
    now[0] = 1000.0
    r = P.analyze(base_req())
    c = P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
    now[0] += 3601
    try:
        # 不手动 _cleanup —— 验证 commit_state 请求时先清理，回放不得越过 TTL
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('C5 回执超 TTL 后请求时清理 → 提交被拒', False, '应 404')
    except _ProtoError as e:
        chk('C5 回执超 TTL 回放被拒（请求时清理）', e.code == "ANALYSIS_NOT_FOUND",
            'code=%s' % e.code)
    chk('C5 回执超 TTL 后候选已被回收', r["analysis_id"] not in P._analyses, '')
    # 容量满：patch 上限小值 → 429
    reset_all()
    now[0] = 1000.0
    with mock.patch.object(SP, 'MAX_ANALYSES', 2):
        with assets_ctx():
            P.analyze(base_req(event="cap1"))
            P.analyze(base_req(event="cap2"))
            try:
                P.analyze(base_req(event="cap3"))
                chk('C5 容量满被拒', False, '')
            except _ProtoError as e:
                chk('C5 容量满 → 429 PENDING_CAPACITY', e.code == "PENDING_CAPACITY", 'code=%s' % e.code)

# ===========================================================================
print("\n[C6] 发布中异常注入 → 无部分状态/历史/版本/事件")
# ===========================================================================
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
    aid = r["analysis_id"]
    base = r["base_state_version"]
    v_before = P.state_version(("demo_01", "lia"))

    class _BoomTrace(dict):
        def setdefault(self, *a, **k):
            raise RuntimeError("注入发布中异常")

    with mock.patch.object(B, '_STATE_TRACE', _BoomTrace()):
        try:
            P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                            "analysis_id": aid, "expected_state_version": base})
            chk('C6 发布中异常被拦截', False, '')
        except _ProtoError as e:
            chk('C6 发布中异常 → INTERNAL_ERROR（已回滚）', e.code == "INTERNAL_ERROR", 'code=%s' % e.code)
    chk('C6 异常后无 Actor State 桶', ("demo_01", "lia") not in B._ACTOR_STATE, '')
    chk('C6 异常后无 trace', not B._STATE_TRACE, '')
    chk('C6 异常后版本未推进', P.state_version(("demo_01", "lia")) == v_before, '')
    chk('C6 异常后事件未置 committed',
        P._events.get(("demo_01", "lia"), {}).get("ev1", {}).get("status") != "committed", '')
    # 候选仍 ready（可重试提交）
    q = P.get_analysis(aid, 'demo_01', 'lia')
    chk('C6 候选仍 ready 可重试', q["status"] == "ready", 'status=%s' % q["status"])

# ===========================================================================
print("\n[R 审查修复反例] 引擎门禁 / 非有限数值 / stale.invalidated 回收")
# ===========================================================================
# R1 引擎未就绪 → analyze 直接 503（不做 fallback 冒充）
reset_all()
with assets_ctx(engine_ready=False):
    try:
        P.analyze(base_req())
        chk('R1 引擎未就绪 analyze 被拒', False, '')
    except _ProtoError as e:
        chk('R1 引擎未就绪 → 503 MODEL_UNAVAILABLE', e.code == "MODEL_UNAVAILABLE", 'code=%s' % e.code)
    chk('R1 引擎未就绪不产生候选', not P._analyses, '')
# R2 checkpoint 不匹配 → 503
reset_all()
with assets_ctx(engine_model="english"):
    try:
        P.analyze(base_req())
        chk('R2 checkpoint 不匹配 analyze 被拒', False, '')
    except _ProtoError as e:
        chk('R2 checkpoint 不匹配 → 503 MODEL_UNAVAILABLE', e.code == "MODEL_UNAVAILABLE", 'code=%s' % e.code)
# R3 Commit 时引擎不满足 → 503（先正常分析，切换身份再提交）
reset_all()
with assets_ctx():
    r = P.analyze(base_req())
with assets_ctx(engine_ready=False):
    try:
        P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                        "analysis_id": r["analysis_id"],
                        "expected_state_version": r["base_state_version"]})
        chk('R3 引擎未就绪 commit 被拒', False, '')
    except _ProtoError as e:
        chk('R3 commit 引擎未就绪 → 503 MODEL_UNAVAILABLE',
            e.code == "MODEL_UNAVAILABLE", 'code=%s' % e.code)
    chk('R3 拒绝后无状态写入', not B._ACTOR_STATE, '')
# R4 非有限 deltas（NaN）→ 不进 writable；commit 不可
reset_all()
bad_nan = (copy.deepcopy(FAKE_DELTAS[0])[:1], {})
bad_nan[0][0]["delta"] = float("nan")
with assets_ctx(deltas=bad_nan):
    r = P.analyze(base_req(event="ev_nan"))
    wd = (r["state_proposal"] or {}).get("writable_delta") or []
    sb = (r["state_proposal"] or {}).get("skipped") or []
    chk('R4 NaN deltas 不进 writable', not wd, 'wd=%d' % len(wd))
    chk('R4 NaN 进 skipped 且 reason 含 UNKNOWN_VALUE',
        any("UNKNOWN_VALUE" in (s.get("reason_codes") or []) for s in sb),
        'sb=%s' % [[s.get("source_signal"), s.get("reason_codes")] for s in sb])
# R5 idempotent accessibility outside protocol: state_transition NaN → skipped
stt = B.state_transition('doubt_shift', float('nan'), 30, allowed=True)
chk('R5 核心公式拒绝 NaN', not stt["committed"] and "非有限" in (stt.get("skipped_reason") or ""),
    'committed=%s reason=%s' % (stt["committed"], stt.get("skipped_reason")))
# R6 stale 记录 terminal_at 并被回收
reset_all()
now[0] = 1000.0
with assets_ctx():
    P.analyze(base_req(event="stale1"))
    P.reset_scope(("demo_01", "lia"))   # 使 stale1 候选 invalidated 且设 terminal_at
    r2 = P.analyze(base_req(event="stale2", expected=P.state_version(("demo_01", "lia"))))
    P.commit_state({"session_id": "demo_01", "actor_id": "lia",
                    "analysis_id": r2["analysis_id"],
                    "expected_state_version": r2["base_state_version"]})
    # 现在有一条 invalidated（stale1 的候选，Reset 后）+ 一条 committed（stale2）
    n_inv = sum(1 for a in P._analyses.values() if a["status"] == "invalidated")
    chk('R6 Reset 产生 invalidated 且记 terminal_at',
        n_inv == 1 and all(a.get("terminal_at") for a in P._analyses.values()
                           if a["status"] in ("invalidated", "stale")), 'n_inv=%d' % n_inv)
    before = len(P._analyses)
    now[0] += 3601
    P._cleanup_expired()
    chk('R6 stale/invalidated 超保留期被回收',
        len(P._analyses) < before and not any(
            a["status"] in ("stale", "invalidated") for a in P._analyses.values()),
        '%d -> %d' % (before, len(P._analyses)))

# ===========================================================================
print("\n[HTTP] 路由层（本机临时端口，mock 翻译/档案，fallback 引擎）")
# ===========================================================================
from http.server import ThreadingHTTPServer

B.reset_actor_state()
B.reset_history()
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
    st, h = _get("/health")
    chk('HTTP /health 200', st == 200, 'st=%s' % st)
    # GET /state（带 scope）→ protocol current
    st, s = _get("/state?session_id=demo_01&actor_id=lia")
    chk('HTTP /state 扩展带 protocol_version/current',
        st == 200 and s.get("protocol_version") == "laya-state-v1" and "current" in s
        and s["current"]["state_version"].startswith("v1:"), 'keys=%s' % sorted(s.keys()))
    # POST /analyze → ready
    ver = s["current"]["state_version"]
    body = {"session_id": "demo_01", "actor_id": "lia", "event_id": "h1",
            "expected_state_version": ver, "message": "你到底想干什么？", "context": {}}
    st, ar = _post("/analyze", body)
    chk('HTTP /analyze 200 ready', st == 200 and ar["status"] == "ready" and ar["analysis_id"],
        'st=%s status=%s' % (st, ar.get("status")))
    # GET /analysis/{id}
    st, qa = _get("/analysis/%s?session_id=demo_01&actor_id=lia" % ar["analysis_id"])
    chk('HTTP GET /analysis 200', st == 200 and qa["analysis_id"] == ar["analysis_id"], 'st=%s' % st)
    # 未知字段 → 422
    st, er = _post("/analyze", dict(body, bogus_field=1))
    chk('HTTP 未知字段 → 422 INVALID_REQUEST', st == 422 and er["error"]["code"] == "INVALID_REQUEST",
        'st=%s code=%s' % (st, er.get("error", {}).get("code")))
    # 坏 JSON → 400 INVALID_JSON
    import urllib.request as _ur
    raw = b"{not json"
    req = _ur.Request(BASE + "/analyze", data=raw, headers={"Content-Type": "application/json"})
    try:
        with _OPENER.open(req, timeout=10) as r:
            st = r.status
    except __import__("urllib.error", fromlist=["HTTPError"]).HTTPError as e:
        st = e.code
    chk('HTTP 坏 JSON → 400', st == 400, 'st=%s' % st)
    # 413 超限
    big = {"session_id": "demo_01", "actor_id": "lia", "event_id": "big",
           "expected_state_version": ver, "message": "x" * 70000, "context": {}}
    st, er = _post("/analyze", big)
    chk('HTTP 请求体超限 → 413 PAYLOAD_TOO_LARGE',
        st == 413 and er["error"]["code"] == "PAYLOAD_TOO_LARGE", 'st=%s code=%s' % (st, er.get("error", {}).get("code")))
    # /commit_state 提交 → committed；重试 replayed
    st, c1 = _post("/commit_state", {"session_id": "demo_01", "actor_id": "lia",
                                     "analysis_id": ar["analysis_id"],
                                     "expected_state_version": ver})
    st, c2 = _post("/commit_state", {"session_id": "demo_01", "actor_id": "lia",
                                     "analysis_id": ar["analysis_id"],
                                     "expected_state_version": ver})
    chk('HTTP /commit_state committed + replayed',
        c1.get("status") == "committed" and c2.get("replayed") is True, 's1=%s s2=%s'
        % (c1.get("status"), c2.get("replayed")))
    # /reject_analysis（用当前版本开新事件）
    st, _ns = _get("/state?session_id=demo_01&actor_id=lia")
    ar2 = _post("/analyze", dict(body, event_id="h2", message="第二句话。",
                                expected_state_version=_ns["current"]["state_version"]))[1]
    st, rr = _post("/reject_analysis", {"session_id": "demo_01", "actor_id": "lia",
                                        "analysis_id": ar2["analysis_id"], "reason": "superseded"})
    chk('HTTP /reject_analysis 200 rejected', st == 200 and rr["status"] == "rejected", 'st=%s' % st)
    # 传输反例：顶层 JSON 数组 → 422（约定错误协议，不越层 404/500）
    import http.client as _hc
    conn = _hc.HTTPConnection('127.0.0.1', port, timeout=5)
    arr = b'["not", "an", "object"]'
    conn.request('POST', '/analyze', body=arr, headers={'Content-Type': 'application/json',
                                                        'Content-Length': str(len(arr))})
    resp = conn.getresponse()
    st_arr = resp.status
    err_arr = json.loads(resp.read().decode())["error"]
    conn.close()
    chk('HTTP 顶层数组 → 422 INVALID_REQUEST (结构化错误)',
        st_arr == 422 and err_arr["code"] == "INVALID_REQUEST", 'st=%s code=%s' % (st_arr, err_arr.get("code")))
    # 传输反例：声明 CL 大于实际字节 → 400（不得带残缺 body 进入路由）。
    # 服务端读超时兜底（Handler.timeout=10s）后返回 400；client 超时要大于它。
    conn = _hc.HTTPConnection('127.0.0.1', port, timeout=15)
    real = b'{}'
    conn.request('POST', '/analyze', body=real, headers={'Content-Type': 'application/json',
                                                         'Content-Length': str(len(real) + 999)})
    resp = conn.getresponse()
    st_cl = resp.status
    err_cl = json.loads(resp.read().decode())
    conn.close()
    chk('HTTP 声明长度大于实际 → 400 INVALID_JSON（不进入路由）',
        st_cl == 400 and err_cl["error"]["code"] == "INVALID_JSON", 'st=%s code=%s'
        % (st_cl, err_cl.get("error", {}).get("code")))
    # 传输反例：Content-Length 非整数 → 400
    conn = _hc.HTTPConnection('127.0.0.1', port, timeout=5)
    conn.putrequest('POST', '/analyze')
    conn.putheader('Content-Type', 'application/json')
    conn.putheader('Content-Length', 'abc')
    conn.endheaders()
    resp = conn.getresponse()
    st_bad = resp.status
    err_bad = json.loads(resp.read().decode())
    conn.close()
    chk('HTTP 非法 Content-Length → 400 INVALID_JSON',
        st_bad == 400 and err_bad["error"]["code"] == "INVALID_JSON", 'st=%s code=%s'
        % (st_bad, err_bad.get("error", {}).get("code")))
srv.shutdown()

print('=' * 92)
print('P2-B1 协议服务自测：合计 %d 项：%d PASS / %d FAIL'
      % (N[0], N[0] - len(FAIL), len(FAIL)))
if FAIL:
    print('失败项：%s' % '、'.join(FAIL))
print('=' * 92)
sys.exit(1 if FAIL else 0)