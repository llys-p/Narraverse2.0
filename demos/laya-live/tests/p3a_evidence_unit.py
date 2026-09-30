"""P3-A · Evidence 候选接线 · 定向检查（零真实模型、零 Laya 权重、零云端、零 HTTP）。

覆盖《P3-A Evidence 候选接线》与《P3 Evidence 接线裁决 v0.1》的 A 固定边界：
  E1  先有事实再取证据：只有 `execution_status=attempted` 且听者在场、方向为
      `lia → player` 的**询问**（question）才产生可写 Evidence；claim/声明不产生。
  E2  单一状态真源：关系写项落在 `(session_id, "lia")` 的 `relationship.doubt`，
      经 `state_transition`（死区/单轮上限/区间）校验，不新建关系库。
  E3  Prepare 零游戏写入：预览含关系写项，但分析前后权威状态不变。
  E4  Commit 不二次调用 Provider：用计数 Provider 验证 Prepare 只调一次，Commit/重放不调。
  E5  fixture 显式 `source=test_fixture`，回执 `rules_only=false` 仅在有可写 Evidence 时；
      无 Provider 或无可写项时恒 `rules_only=true, laya_evidence=[]`。
  E6  错误 NPC / 方向不明 / 非 question / 被阻止动作 → 无可写 Evidence。
  E7  幂等重放不二次叠加关系 delta；回滚走现有机制。

P3-A-R1 复审修复补强反例（标签 R1-①~⑫）：
  · 档案身份：候选固化**服务端**取得的档案/检查点身份（独立身份源，非 Provider 自报
    字符串）；Commit 锁内重读比较，变化 → 409 CAPABILITY_CHANGED、零写入、不调模型。
  · Provider 可见数据：make_provider_input 不传玩家完整 actor_state、剔除各角色
    interaction.knowledge；回执 Evidence 只保留协议白名单字段，不透传 Provider 原始字段。
  · 同轮关系写项：同 NPC 同路径多条可写 Evidence 按顺序累加、对整轮应用一次 transition
    上限，不从旧 doubt 起算后静默覆盖。
  · 锁边界：Provider 在 Prepare 锁外调用；重新入锁后状态变化 → 409 STATE_VERSION_CONFLICT
    （不发布旧候选），Prepare 零写、Commit 唯一写、Commit 不二次推理。

P3-A-R2 同事件并发单飞补强反例（标签 R2-①~⑨，确定性双线程屏障）：
  · 同 (session_id, event_id) 并发只调用一次 Provider，不留两个可提交候选；同载荷并发返回
    409 PREPARE_IN_PROGRESS，不同载荷返回 409 EVENT_PAYLOAD_CONFLICT。
  · Provider 异常 → 500 且释放 in-flight 占用；随后可重新 Prepare。
  · in-flight 键为 (session_id, event_id)，登记/复核/释放在 P.lock 内；重新入锁发布前复核
    占用归属、事件、版本、锁外期间变化的档案身份与规则指纹。

P3-A-R3 补齐 in-flight 异常释放与容量预留（标签 R3-①~⑥）：
  · 第一段登记 in-flight 后，规则计算/身份源/规则指纹/Provider 输入构造任一抛异常都释放占用；
    身份源首次抛异常、随后恢复，同一事件可重新 Prepare，不再永久 PREPARE_IN_PROGRESS。
  · 容量检查计入已占用的 in-flight 并预留本次请求：199 个 Pending + 并发两事件 → 第二个
    429 PENDING_CAPACITY，最终 Pending 不超过 MAX_PENDING。

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p3a_evidence_unit.py`
"""
import copy
import json
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_evidence as EV
from laya_delivery_core import WORLD, MAX_PENDING, DeliveryCore
from laya_state_protocol import _ProtoError  # noqa: F401

FAIL = []
N = [0]


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


def fresh(sid, provider=None, capability_identity=None):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P, evidence_provider=provider,
                        capability_identity=capability_identity)
    core.ensure_scene(sid)
    return core, P


def doubt(core, sid):
    return core.state(sid)["states"]["lia"]["relationship"]["doubt"]


def ask(obj="cellar_key", listener="lia", kind="question", mode="attempt"):
    return {"id": "a1", "operation": "communicate", "target_ids": [listener],
            "object_id": obj, "mode": mode, "kind": kind,
            "content": "钥匙在哪", "evidence": "钥匙在哪"}


def prep(core, sid, actions, ev="ev1", actor="player"):
    return core.prepare_structured({"session_id": sid, "event_id": ev, "actor_id": actor,
                                    "expected_versions": core.state(sid)["versions"],
                                    "actions": actions})


def commit(core, sid, pv, ev="ev1"):
    return core.commit({"session_id": sid, "event_id": ev,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})


# ------------------------------------------------------------------ E1/E5 正向链
def test_question_produces_writable_evidence():
    core, P = fresh("p3a-e1", EV.fixture_provider(5.0))
    before = doubt(core, "p3a-e1")
    pv = prep(core, "p3a-e1", [ask()])
    chk("E1-① 询问在场且方向 lia→player 时产生可写 Evidence",
        pv["status"] == "ready" and pv["rules_only"] is False
        and len(pv["laya_evidence"]) == 1, str(pv["laya_evidence"]))
    ev = pv["laya_evidence"][0]
    chk("E5-① fixture 显式 source=test_fixture（不冒充真实 Laya）",
        ev["source"] == "test_fixture" and ev["target_npc"] == "lia"
        and ev["action_id"] == "a1", str(ev))
    sig = ev["signals"][0]
    chk("E2-① 可写信号 role=state_shift 且 status=active 的 doubt_shift",
        sig["signal"] == "doubt_shift" and sig["role"] == "state_shift"
        and sig["status"] == "active" and sig["may_write"] is True, str(sig))
    rel_change = [c for c in pv["state_proposal"]["changes"]
                  if c["path"] == "relationship.doubt"]
    chk("E2-② 关系写项落在 lia 的 relationship.doubt（单一状态真源）",
        len(rel_change) == 1 and rel_change[0]["entity_id"] == "lia"
        and rel_change[0]["before"] == 30 and rel_change[0]["after"] == 35.0
        and rel_change[0]["source"].startswith("laya_evidence:"), str(rel_change))
    chk("E3-① Prepare 零游戏写入：分析前后 doubt 不变",
        doubt(core, "p3a-e1") == before, "before=%s after=%s" % (before, doubt(core, "p3a-e1")))

    rec = commit(core, "p3a-e1", pv)
    chk("E1-② Commit 后 doubt 真正落盘（30→35）",
        rec["status"] == "committed" and doubt(core, "p3a-e1") == 35.0,
        "doubt=%s" % doubt(core, "p3a-e1"))
    chk("E5-② 回执 rules_only=false 且有 Evidence（有可写项时）",
        rec["rules_only"] is False and len(rec["laya_evidence"]) == 1, "")

    # 幂等重放不二次叠加
    rec2 = commit(core, "p3a-e1", pv)
    chk("E7-① 同请求重放幂等：doubt 不二次叠加",
        rec2.get("replayed") is True and doubt(core, "p3a-e1") == 35.0,
        "doubt=%s" % doubt(core, "p3a-e1"))


# ------------------------------------------------------------------ E5 无 Provider
def test_no_provider_rules_only():
    core, P = fresh("p3a-none")  # 无 provider
    pv = prep(core, "p3a-none", [ask()])
    chk("E5-③ 无 Provider 时恒 rules_only=true、laya_evidence=[]",
        pv["rules_only"] is True and pv["laya_evidence"] == []
        and doubt(core, "p3a-none") == 30, str(pv["laya_evidence"]))


# ------------------------------------------------------------------ E6 无可写项的各种反例
def test_no_writable_for_non_question_and_wrong_target():
    # claim 不产生（裁决：claim 不产生可写 Evidence）
    core, P = fresh("p3a-claim", EV.fixture_provider(5.0))
    pv = prep(core, "p3a-claim", [ask(kind="claim", obj=None)])
    chk("E6-① claim 不产生可写 Evidence（rules_only=true）",
        pv["rules_only"] is True and pv["laya_evidence"] == [], str(pv["laya_evidence"]))

    # 目标为自己 → blocked，无可写
    core2, P2 = fresh("p3a-self", EV.fixture_provider(5.0))
    pv2 = prep(core2, "p3a-self", [ask(listener="player")])
    chk("E6-② 目标为自身 → blocked 且无可写 Evidence",
        pv2["status"] == "blocked" and pv2["laya_evidence"] == []
        and pv2["rules_only"] is True, str(pv2["reason_codes"]))

    # 听者不在场 → blocked
    core3, P3 = fresh("p3a-away", EV.fixture_provider(5.0))
    B._ACTOR_STATE[("p3a-away", "lia")]["interaction"]["location"] = "old_well"
    pv3 = prep(core3, "p3a-away", [ask()])
    chk("E6-③ 听者不在场 → blocked 且无可写 Evidence",
        pv3["status"] == "blocked" and pv3["laya_evidence"] == []
        and pv3["rules_only"] is True, str(pv3["reason_codes"]))


# ------------------------------------------------------------------ E4 Commit 不二次调用
def test_commit_does_not_recall_provider():
    calls = [0]

    def counting(delta):
        def p(inp):
            calls[0] += 1
            return EV.fixture_provider(delta)(inp)
        return p

    core, P = fresh("p3a-count", counting(5.0))
    pv = prep(core, "p3a-count", [ask()])
    n_after_prepare = calls[0]
    commit(core, "p3a-count", pv)
    n_after_commit = calls[0]
    commit(core, "p3a-count", pv)  # 重放
    n_after_replay = calls[0]
    chk("E4-① Commit 不二次调用 Provider（prepare=1、commit=1、replay=1）",
        n_after_prepare == 1 and n_after_commit == 1 and n_after_replay == 1,
        "prepare=%d commit=%d replay=%d" % (n_after_prepare, n_after_commit, n_after_replay))


# ------------------------------------------------------------------ E2 死区 / 单轮上限
def test_transition_clamps():
    # 死区：|delta|<1.0 归零 → 无可写项
    core, P = fresh("p3a-dz", EV.fixture_provider(0.5))
    pv = prep(core, "p3a-dz", [ask()])
    rel = [c for c in pv["state_proposal"]["changes"] if c["path"] == "relationship.doubt"]
    chk("E2-③ 死区（|delta|<1.0）归零，不产生关系写项",
        pv["rules_only"] is True and rel == [], str(pv["laya_evidence"]))

    # 单轮上限：delta=50 → 被 per_turn 截到 +10
    core2, P2 = fresh("p3a-cap", EV.fixture_provider(50.0))
    pv2 = prep(core2, "p3a-cap", [ask()])
    rel2 = [c for c in pv2["state_proposal"]["changes"] if c["path"] == "relationship.doubt"]
    chk("E2-④ 单轮上限截顶：doubt_shift +50 → 实际 +10（30→40）",
        len(rel2) == 1 and rel2[0]["after"] == 40.0, str(rel2))


# ------------------------------------------------------------------ R1-① 档案身份重验
def test_capability_identity_revalidation():
    ident = [{"profile_id": "p1", "checkpoint": "c1"}]
    core, P = fresh("p3a-capid", EV.fixture_provider(5.0),
                    capability_identity=lambda: ident[0])
    pv = prep(core, "p3a-capid", [ask()])
    chk("R1-① 候选固化服务端档案/检查点身份（预览可提交）",
        pv["status"] == "ready" and pv["rules_only"] is False, str(pv["reason_codes"]))

    ident[0] = {"profile_id": "p2", "checkpoint": "c2"}  # 服务端身份源变化
    err = None
    try:
        commit(core, "p3a-capid", pv)
    except _ProtoError as e:
        err = e
    chk("R1-② Commit 锁内重读身份并比较：变化 → 409 CAPABILITY_CHANGED（不提交、不调模型）",
        err is not None and err.code == "CAPABILITY_CHANGED", str(getattr(err, "code", None)))
    chk("R1-③ 身份变化后状态零写入：doubt 不变",
        doubt(core, "p3a-capid") == 30, "doubt=%s" % doubt(core, "p3a-capid"))

    ident2 = [{"profile_id": "p3", "checkpoint": "c3"}]
    core2, P2 = fresh("p3a-capid2", EV.fixture_provider(5.0),
                      capability_identity=lambda: ident2[0])
    pv2 = prep(core2, "p3a-capid2", [ask()])
    rec = commit(core2, "p3a-capid2", pv2)  # 身份未变 → 正常提交
    chk("R1-④ 身份未变时正常提交",
        rec["status"] == "committed" and doubt(core2, "p3a-capid2") == 35.0,
        "status=%s doubt=%s" % (rec["status"], doubt(core2, "p3a-capid2")))


# ------------------------------------------------------------------ R1-② Provider 可见数据白名单
def test_provider_visibility_whitelist():
    core, P = fresh("p3a-leak", EV.fixture_provider(5.0))
    SENTINEL = "SENTINEL-SECRET-123"
    B._ACTOR_STATE[("p3a-leak", "lia")]["interaction"]["knowledge"].append(
        {"entry_id": "sentinel", "kind": "clue", "content": SENTINEL})
    B._ACTOR_STATE[("p3a-leak", "player")]["interaction"].setdefault("knowledge", []).append(
        {"entry_id": "sentinel", "kind": "clue", "content": SENTINEL})
    seen = {}

    def spy(inp):
        seen["blob"] = json.dumps(inp, ensure_ascii=False)
        # Provider 附带一个原始字段，验证回执白名单把它过滤掉。
        return [dict(EV.fixture_provider(5.0)(inp)[0], leaked_extra="RAW-LEAK-FIELD")]

    core._evidence_provider = spy
    pv = prep(core, "p3a-leak", [ask()])
    rec = commit(core, "p3a-leak", pv)
    blob = seen["blob"]
    rec_blob = json.dumps(rec.get("laya_evidence"), ensure_ascii=False)
    chk("R1-⑤ Provider 输入不含玩家完整 actor_state / 其它角色私有知识哨兵值",
        SENTINEL not in blob, "blob_len=%d" % len(blob))
    chk("R1-⑥ 回执 Evidence 不含哨兵值、不含 Provider 附带原始字段（白名单）",
        SENTINEL not in rec_blob and "RAW-LEAK-FIELD" not in rec_blob
        and "leaked_extra" not in rec_blob, "")
    ev0 = rec["laya_evidence"][0]
    chk("R1-⑦ 回执 Evidence 条目只含白名单字段",
        set(ev0.keys()) <= set(EV.EVIDENCE_FIELDS), str(sorted(ev0.keys())))


# ------------------------------------------------------------------ R1-③ 同轮关系写项口径
def test_same_turn_accumulation():
    core, P = fresh("p3a-acc", EV.fixture_provider_multi([5.0, 3.0]))
    actions = [
        {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
         "object_id": "cellar_key", "mode": "attempt", "kind": "question",
         "content": "钥匙在哪", "evidence": "钥匙在哪"},
        {"id": "a2", "operation": "communicate", "target_ids": ["lia"],
         "object_id": "cellar_key", "mode": "attempt", "kind": "question",
         "content": "钥匙在哪", "evidence": "钥匙在哪"},
    ]
    pv = prep(core, "p3a-acc", actions)
    rel = [c for c in pv["state_proposal"]["changes"] if c["path"] == "relationship.doubt"]
    chk("R1-⑧ 同轮两条可写 Evidence 按顺序累加（5+3=8）成**一条**写项（30→38）",
        len(rel) == 1 and rel[0]["before"] == 30 and rel[0]["after"] == 38.0
        and rel[0]["source"] == "laya_evidence:a1,a2:doubt_shift", str(rel))
    commit(core, "p3a-acc", pv)
    chk("R1-⑨ 累加后 doubt 落盘 38（不静默覆盖为 35 或 33）",
        doubt(core, "p3a-acc") == 38.0, "doubt=%s" % doubt(core, "p3a-acc"))

    core2, P2 = fresh("p3a-acc-cap", EV.fixture_provider_multi([7.0, 8.0]))
    pv2 = prep(core2, "p3a-acc-cap", actions)
    rel2 = [c for c in pv2["state_proposal"]["changes"] if c["path"] == "relationship.doubt"]
    chk("R1-⑩ 同轮累加对整轮应用一次单轮上限（7+8=15 → 截到 +10，30→40）",
        len(rel2) == 1 and rel2[0]["after"] == 40.0, str(rel2))


# ------------------------------------------------------------------ R1-④ Provider 锁边界
def test_provider_called_outside_lock():
    observed = {}

    def slow(inp):
        observed["owned"] = B.PROTOCOL.lock._is_owned()   # 锁外应为 False
        # 模拟锁外窗口内状态变化（另一写入抢先）
        B._ACTOR_STATE[("p3a-lock", "lia")]["relationship"]["doubt"] = 99
        B.PROTOCOL._bump_revision(("p3a-lock", "lia"))
        return EV.fixture_provider(5.0)(inp)

    core, P = fresh("p3a-lock", slow)
    err = None
    try:
        prep(core, "p3a-lock", [ask()])
    except _ProtoError as e:
        err = e
    chk("R1-⑪ Provider 在锁外被调用（不持全局锁）",
        observed.get("owned") is False, "owned=%s" % observed.get("owned"))
    chk("R1-⑫ 锁外窗口状态变化 → 重新入锁复核 → 409 STATE_VERSION_CONFLICT（不发布旧候选）",
        err is not None and err.code == "STATE_VERSION_CONFLICT",
        str(getattr(err, "code", None)))


# ------------------------------------------------------------------ R2 同事件并发单飞
def test_concurrent_same_event_single_provider():
    """双线程屏障：同 (session_id, event_id) 同载荷并发 → 只调一次 Provider、只留一个候选。"""
    core, P = fresh("p3a-conc1", None)
    entered = threading.Event()
    release = threading.Event()
    calls = [0]

    def blocking_provider(inp):
        calls[0] += 1
        entered.set()
        release.wait(timeout=10)   # 阻塞，确保第二个请求此刻进入并发窗口
        return EV.fixture_provider(5.0)(inp)

    core._evidence_provider = blocking_provider
    action = {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
              "object_id": "cellar_key", "mode": "attempt", "kind": "question",
              "content": "钥匙在哪", "evidence": "钥匙在哪"}

    result = {}

    def worker():
        try:
            result["pv"] = prep(core, "p3a-conc1", [action], ev="ev-conc")
        except _ProtoError as e:
            result["err"] = e

    t1 = threading.Thread(target=worker)
    t1.start()
    chk("R2-① 线程 A 进入锁外 Provider", entered.wait(timeout=10), "")

    errB = None
    try:
        prep(core, "p3a-conc1", [action], ev="ev-conc")   # 同事件同载荷，并发
    except _ProtoError as e:
        errB = e
    release.set()
    t1.join(timeout=10)

    pendings = [c for c in core._pending.values() if c["event_id"] == "ev-conc"]
    chk("R2-② 同事件只调用一次 Provider", calls[0] == 1, "calls=%d" % calls[0])
    chk("R2-③ 并发同载荷第二个请求明确 PREPARE_IN_PROGRESS",
        errB is not None and errB.code == "PREPARE_IN_PROGRESS",
        str(getattr(errB, "code", None)))
    chk("R2-④ 不留下两个可提交候选（至多一个 Pending）",
        len(pendings) == 1 and result.get("pv") is not None, "pendings=%d" % len(pendings))


def test_concurrent_different_payload_conflict():
    """双线程屏障：同事件不同载荷并发 → 第二个请求明确 EVENT_PAYLOAD_CONFLICT。"""
    core, P = fresh("p3a-conc2", None)
    entered = threading.Event()
    release = threading.Event()

    def blocking_provider(inp):
        entered.set()
        release.wait(timeout=10)
        return EV.fixture_provider(5.0)(inp)

    core._evidence_provider = blocking_provider
    actionA = {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
               "object_id": "cellar_key", "mode": "attempt", "kind": "question",
               "content": "钥匙在哪", "evidence": "钥匙在哪"}
    actionB = {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
               "object_id": None, "mode": "attempt", "kind": "question",
               "content": "别的问法", "evidence": "别的问法"}

    t1 = threading.Thread(target=lambda: prep(core, "p3a-conc2", [actionA], ev="ev-conc"))
    t1.start()
    chk("R2-⑤ 线程 A 进入锁外 Provider", entered.wait(timeout=10), "")
    errB = None
    try:
        prep(core, "p3a-conc2", [actionB], ev="ev-conc")   # 同事件不同载荷
    except _ProtoError as e:
        errB = e
    release.set()
    t1.join(timeout=10)
    chk("R2-⑥ 并发不同载荷 → 409 EVENT_PAYLOAD_CONFLICT",
        errB is not None and errB.code == "EVENT_PAYLOAD_CONFLICT",
        str(getattr(errB, "code", None)))


def test_provider_failure_releases_inflight():
    """Provider 异常 → 500 且释放占用；随后可用正常 Provider 重新 Prepare。"""
    core, P = fresh("p3a-fail", None)

    def failing(inp):
        raise RuntimeError("boom")

    core._evidence_provider = failing
    err = None
    try:
        prep(core, "p3a-fail", [ask()], ev="ev-fail")
    except _ProtoError as e:
        err = e
    chk("R2-⑦ Provider 异常 → 500 INTERNAL_ERROR",
        err is not None and err.code == "INTERNAL_ERROR", str(getattr(err, "code", None)))
    chk("R2-⑧ 异常后 in-flight 占用已释放",
        ("p3a-fail", "ev-fail") not in core._inflight, "")

    core._evidence_provider = EV.fixture_provider(5.0)
    pv = prep(core, "p3a-fail", [ask()], ev="ev-fail")
    chk("R2-⑨ Provider 失败后可重新 Prepare（正常提交）",
        pv["status"] == "ready" and pv["rules_only"] is False, str(pv["reason_codes"]))


# ------------------------------------------------------------------ R3 第一段异常释放 + 容量预留
def test_first_segment_exception_releases_inflight():
    """第一段登记 in-flight 后，身份源读取抛异常 → 释放占用；恢复后同一事件可重新 Prepare。"""
    core, P = fresh("p3a-ident", EV.fixture_provider(5.0))
    calls = [0]

    def flaky_identity():
        calls[0] += 1
        if calls[0] == 1:
            raise RuntimeError("identity boom")
        return {"profile_id": "p1", "checkpoint": "c1"}

    core._capability_identity = flaky_identity
    err = None
    try:
        prep(core, "p3a-ident", [ask()], ev="ev-ident")
    except Exception as e:  # noqa: BLE001  —— 身份源抛的是 RuntimeError
        err = e
    chk("R3-① 身份源首次抛异常被透出（RuntimeError）",
        err is not None and isinstance(err, RuntimeError), str(type(err)))
    chk("R3-② 异常后 in-flight 占用已释放",
        ("p3a-ident", "ev-ident") not in core._inflight, "")

    pv = prep(core, "p3a-ident", [ask()], ev="ev-ident")   # 身份源已恢复
    chk("R3-③ 身份源恢复后同一事件可重新 Prepare（不再永久 PREPARE_IN_PROGRESS）",
        pv["status"] == "ready" and pv["rules_only"] is False, str(pv["reason_codes"]))


def test_capacity_reserves_inflight():
    """容量检查计入 in-flight：199 个 Pending + 并发两个事件 → 第二个 429，最终 ≤ MAX_PENDING。"""
    core, P = fresh("p3a-cap", None)
    for i in range(MAX_PENDING - 1):
        core._pending["fake-%d" % i] = {
            "session_id": "p3a-cap", "event_id": "ev-fake-%d" % i, "expires_at": None,
        }

    entered = threading.Event()
    release = threading.Event()

    def blocking_provider(inp):
        entered.set()
        release.wait(timeout=10)
        return EV.fixture_provider(5.0)(inp)

    core._evidence_provider = blocking_provider
    action = {"id": "a1", "operation": "communicate", "target_ids": ["lia"],
              "object_id": "cellar_key", "mode": "attempt", "kind": "question",
              "content": "钥匙在哪", "evidence": "钥匙在哪"}

    tA = threading.Thread(target=lambda: prep(core, "p3a-cap", [action], ev="ev-A"))
    tA.start()
    chk("R3-④ 事件 A 进入锁外 Provider（in-flight 占用 +1）", entered.wait(timeout=10), "")

    errB = None
    try:
        prep(core, "p3a-cap", [action], ev="ev-B")   # 不同事件，容量 199+1+1=201>200
    except _ProtoError as e:
        errB = e
    release.set()
    tA.join(timeout=10)

    chk("R3-⑤ 并发第二事件明确 429 PENDING_CAPACITY",
        errB is not None and errB.code == "PENDING_CAPACITY",
        str(getattr(errB, "code", None)))
    chk("R3-⑥ 最终 Pending 不超过 MAX_PENDING（199 假 + 1 真 = 200）",
        len(core._pending) <= MAX_PENDING, "pending=%d" % len(core._pending))


def main():
    test_question_produces_writable_evidence()
    test_no_provider_rules_only()
    test_no_writable_for_non_question_and_wrong_target()
    test_commit_does_not_recall_provider()
    test_transition_clamps()
    test_capability_identity_revalidation()
    test_provider_visibility_whitelist()
    test_same_turn_accumulation()
    test_provider_called_outside_lock()
    test_concurrent_same_event_single_provider()
    test_concurrent_different_payload_conflict()
    test_provider_failure_releases_inflight()
    test_first_segment_exception_releases_inflight()
    test_capacity_reserves_inflight()
    print("\nP3-A Evidence 候选接线定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零真实模型、零 Laya、零云端、零 HTTP）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
