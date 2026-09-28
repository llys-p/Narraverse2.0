"""P2-B2b 单一非致命对抗（attack / kind=challenge）六档的服务端事实链 · 定向检查。

零模型、零云端、零 HTTP、零 Laya。覆盖《P2-B2b 单一六档对抗与贡献解释》的 A 固定口径：

  A  六档整数边界：<=-5 critical_failure / -4..-2 failure / -1..0 partial_success /
     1..3 success / 4..5 strong_success / >=6 exceptional_success；聚合取**最低**档
  B  硬前提短路：目标为自身 / 不同位置 / 任一方 incapacitated|restrained /
     energy<2 → blocked + degree=null + **无任何资源扣减**（不用「有限难度惩罚」代替拒绝）；
     目标名字无法解析 → 409 NEEDS_CLARIFICATION（沿用全局 `target_unresolved` 口径，
     同样不写状态、不扣资源）
  C  kind 闭集：仅 `kind=challenge` 进公式；violence/threat/未声明 kind →
     409 UNSUPPORTED_OPERATION，不悄悄转成角力；**非空 `object_id` 同样 409 拒绝**
     （带物品会改变语义：持械 vs 徒手，不静默按徒手结算）
  D  各档真实效果：所有**已尝试**档位扣 2 energy；目标 `balance_pressure` 增量
     partial/success/strong/exceptional = 1/2/3/4 且截顶 4；failure 不动目标；
     critical_failure 行动者自身 +1；opportunity 只作下一轮建议、不自动执行
  E  客户端注入 difficulty/margin/degree/outcome/delta/success 与未声明字段 → 422
  F  同一 event 重放幂等（不二次扣 energy/失衡/时钟）；发布段异常 → 全回退、无半提交
  G  聚合取最低档；`DEGREE_SUCCESSFUL` 决定条件动作（if_achieved）是否执行
  H  规则边界：attack 已实现、P2_OPERATIONS 已空；rules_only=True 且 laya_evidence 为空
  W  P2-B2b-R1 解释器接线（固定响应、零云端）：原话「我推搡莉亚」→ challenge →
     `to_prepare_request` → Prepare → Commit → 下一轮读到 energy 与 balance_pressure；
     `violence` 如实解释但不进结算；带物品 attack 被拒且状态零变化

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p2b2b_contest_unit.py`
"""
import copy
import json
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_delivery_interpreter as I
from laya_delivery_core import (
    WORLD, DeliveryCore, _degree_for_margin, _aggregate_attempted,
    DEGREE_ORDER, DEGREE_SUCCESSFUL, BALANCE_PRESSURE_LIMIT,
    ATTACK_ENERGY_COST, ATTACK_BASE_RESISTANCE, ATTACK_KINDS,
    IMPLEMENTED_OPERATIONS, P2_OPERATIONS)
from laya_state_protocol import _ProtoError  # noqa: F401  （与 expect_error 配套）

FAIL = []
N = [0]

#: 默认场景里莉亚的 defense（六档推导的固定另一半）；改档位只动玩家 strength。
LIA_DEFENSE = 2
BASE_DIFFICULTY = LIA_DEFENSE + ATTACK_BASE_RESISTANCE


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


def expect_error(tag, fn, code):
    try:
        fn()
    except _ProtoError as e:
        chk(tag, e.code == code, "%s %s" % (e.code, (e.message or "")[:70]))
        return e
    chk(tag, False, "未抛出错误，期望 %s" % code)
    return None


def fresh(sid):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)
    return core, P, sid


def prepare(core, sid, actions, event, actor="player"):
    return core.prepare_structured({
        "session_id": sid, "event_id": event, "actor_id": actor,
        "expected_versions": core.state(sid)["versions"], "actions": actions,
    })


def commit(core, sid, pv, event):
    return core.commit({"session_id": sid, "event_id": event,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})


def world_of(core, sid):
    return core.state(sid)["states"][WORLD]["interaction"]


def actor_of(core, sid, who):
    return core.state(sid)["states"][who]["interaction"]


def atk(aid, target="lia", kind="challenge", mode="attempt"):
    return {"id": aid, "operation": "attack",
            "target_ids": [target] if target else [], "object_id": None,
            "mode": mode, "kind": kind, "content": "", "evidence": ""}


def claim(aid, content="哼", listener="lia", depends_on=None, when="always"):
    row = {"id": aid, "operation": "communicate", "target_ids": [listener],
           "object_id": None, "mode": "attempt", "kind": "claim",
           "content": content, "evidence": content}
    if depends_on:
        row["depends_on"] = depends_on
        row["when"] = when
    return row


def look(aid, subject, depends_on=None, when="always"):
    row = {"id": aid, "operation": "inspect", "target_ids": [], "object_id": subject,
           "mode": "attempt", "kind": "inspect", "content": "", "evidence": ""}
    if depends_on:
        row["depends_on"] = depends_on
        row["when"] = when
    return row


def set_stats(sid, who, **kw):
    """直接改权威桶的 stats（服务端事实；只用于把 margin 摆到指定档位）。"""
    inter = B._ACTOR_STATE[(sid, who)]["interaction"]
    inter.setdefault("stats", {}).update(kw)


def set_inter(sid, who, **kw):
    B._ACTOR_STATE[(sid, who)]["interaction"].update(kw)


def fake(payload):
    """固定返回的假云端 caller（零云端）；payload 可为 dict 或 JSON 字符串。"""
    raw = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)

    def caller(system, user):
        caller.last_prompt = (system, user)
        return raw, None
    return caller


class _BoomTrace(dict):
    def setdefault(self, key, default=None):
        raise RuntimeError("injected publish failure")


# ------------------------------------------------------------------ A 六档边界
def test_degree_boundaries():
    cases = [(-99, "critical_failure"), (-5, "critical_failure"),
             (-4, "failure"), (-2, "failure"),
             (-1, "partial_success"), (0, "partial_success"),
             (1, "success"), (3, "success"),
             (4, "strong_success"), (5, "strong_success"),
             (6, "exceptional_success"), (99, "exceptional_success")]
    bad = [(m, _degree_for_margin(m), want) for m, want in cases
           if _degree_for_margin(m) != want]
    chk("A1-六档整数边界逐点正确（-5/-4/-2/-1/0/1/3/4/5/6 及两端）", not bad, str(bad))
    chk("A2-档位表本身是 6 档且无重复",
        len(DEGREE_ORDER) == 6 and len(set(DEGREE_ORDER)) == 6, str(DEGREE_ORDER))
    chk("A3-成功类档位闭集一致（DEGREE_SUCCESSFUL 是 DEGREE_ORDER 末三档）",
        set(DEGREE_SUCCESSFUL) == set(DEGREE_ORDER[-3:]), str(DEGREE_SUCCESSFUL))

    def agg(*ds):
        return _aggregate_attempted([{"degree": d} for d in ds])

    chk("A4-聚合取最低档：success+partial → partial_success",
        agg("success", "partial_success") == ("partial_success", "partial_success"), "")
    chk("A5-聚合取最低档：partial+failure → failed/failure",
        agg("partial_success", "failure") == ("failed", "failure"), "")
    chk("A6-成功类混合仍 → achieved/success（对旧动作无行为改变）",
        agg("success", "strong_success", "exceptional_success") == ("achieved", "success"), "")
    chk("A7-critical_failure 拉低整轮 → failed/critical_failure",
        agg("exceptional_success", "critical_failure") == ("failed", "critical_failure"), "")


# ------------------------------------------------------------------ C kind 闭集
def test_kind_closed_set():
    core, P, sid = fresh("b2b-kind")
    for kind, tag, slug in (("violence", "kind=violence", "violence"),
                            ("threat", "kind=threat", "threat"),
                            ("", "未声明 kind", "missing")):
        expect_error("C-%s 的 attack → 409 UNSUPPORTED_OPERATION（不悄悄当角力）" % tag,
                     lambda k=kind, s=slug: prepare(core, sid, [atk("a1", kind=k)],
                                                    "kind-" + s),
                     "UNSUPPORTED_OPERATION")
    chk("C-ATTACK_KINDS 只声明 challenge", ATTACK_KINDS == ("challenge",), str(ATTACK_KINDS))
    pv = prepare(core, sid, [atk("a1", kind="challenge")], "kind-ok")
    chk("C-kind=challenge 进公式（ready、可提交）",
        pv["status"] == "ready" and pv["can_commit"] is True, str(pv["reason_codes"]))

    # P2-B2b-R1：带物品的 attack 显式拒绝，不静默按徒手结算，且状态零变化。
    snap = copy.deepcopy(B._ACTOR_STATE)
    armed = atk("a1", kind="challenge")
    armed["object_id"] = "badge"
    expect_error("C-带 object_id 的 attack → 409 UNSUPPORTED_OPERATION"
                 "（持械 vs 徒手语义不同，不静默结算）",
                 lambda: prepare(core, sid, [armed], "kind-obj"),
                 "UNSUPPORTED_OPERATION")
    chk("C-带物品 attack 被拒后状态零变化、无回合事件",
        B._ACTOR_STATE == snap
        and actor_of(core, sid, "player")["energy"] == 10
        and actor_of(core, sid, "lia")["balance_pressure"] == 0
        and world_of(core, sid)["turn_tick"] == 0, "")


# ------------------------------------------------------------------ B 硬前提短路
def test_hard_preconditions():
    cases = [
        ("B1-目标是自身 → blocked", None, atk("a1", target="player"), "target_is_self"),
        ("B2-目标不在同地点 → blocked",
         lambda sid: set_inter(sid, "lia", location="old_well"),
         atk("a1"), "target_out_of_reach"),
        ("B3-目标 incapacitated → blocked",
         lambda sid: set_inter(sid, "lia", incapacitated=True),
         atk("a1"), "target_incapacitated"),
        ("B4-目标 restrained → blocked",
         lambda sid: set_inter(sid, "lia", restrained=True),
         atk("a1"), "target_restrained"),
        ("B5-行动者 incapacitated → blocked",
         lambda sid: set_inter(sid, "player", incapacitated=True),
         atk("a1"), "actor_incapacitated"),
        ("B6-行动者 restrained → blocked",
         lambda sid: set_inter(sid, "player", restrained=True),
         atk("a1"), "actor_restrained"),
        ("B7-energy<2 → blocked",
         lambda sid: set_inter(sid, "player", energy=1),
         atk("a1"), "insufficient_energy"),
    ]
    for tag, mutate, act, reason in cases:
        core, P, sid = fresh("b2b-" + reason)
        if mutate:
            mutate(sid)
        e0 = actor_of(core, sid, "player")["energy"]
        b0 = actor_of(core, sid, "lia")["balance_pressure"]
        pv = prepare(core, sid, [act], "hp-" + reason)
        r = pv["outcome"]["resolutions"][0]
        detail = "reasons=%s degree=%s changes=%d energy=%s/%s" % (
            r["check"]["reasons"], r["degree"],
            len(pv["state_proposal"]["changes"]),
            actor_of(core, sid, "player")["energy"], e0)
        chk(tag, (pv["status"] == "blocked" and r["execution_status"] == "blocked"
                  and r["degree"] is None and reason in r["check"]["reasons"]
                  and pv["state_proposal"]["changes"] == []
                  and actor_of(core, sid, "player")["energy"] == e0
                  and actor_of(core, sid, "lia")["balance_pressure"] == b0), detail)
        expect_error("  %s：被阻止候选不可提交" % tag.split("-")[0],
                     lambda c=core, s=sid, p=pv, ev="hp-" + reason: commit(c, s, p, ev),
                     "ANALYSIS_NOT_COMMITTABLE")

    # 目标名字无法解析 → 沿用全局澄清口径（同样不写、不扣）
    core, P, sid = fresh("b2b-clarify")
    e0 = actor_of(core, sid, "player")["energy"]
    expect_error("B8-目标名无法解析 → 409 NEEDS_CLARIFICATION（不暗选、不扣资源）",
                 lambda: prepare(core, sid, [atk("a1", target="ghost")], "hp-clarify"),
                 "NEEDS_CLARIFICATION")
    chk("B8-澄清路径没有任何写入或资源扣减",
        actor_of(core, sid, "player")["energy"] == e0
        and world_of(core, sid)["turn_tick"] == 0
        and pv_is_empty(core, sid), "")


def pv_is_empty(core, sid):
    st = core.state(sid)["states"]
    return (st[WORLD]["interaction"]["turn_tick"] == 0
            and st["player"]["interaction"]["energy"] == 10
            and st["lia"]["interaction"]["balance_pressure"] == 0)


# ------------------------------------------------------------------ D 各档真实效果
def test_six_degrees_end_to_end():
    plan = [
        # degree, 玩家 strength, margin, 目标失衡增量, 行动者自身失衡增量, 整轮 result
        ("critical_failure", 0, 0, 1, "failed"),
        ("failure", 1, 0, 0, "failed"),
        ("partial_success", 5, 1, 0, "partial_success"),
        ("success", 6, 2, 0, "achieved"),
        ("strong_success", 9, 3, 0, "achieved"),
        ("exceptional_success", 11, 4, 0, "achieved"),
    ]
    for degree, strength, gain, self_gain, result in plan:
        core, P, sid = fresh("b2b-e2e-" + degree)
        set_stats(sid, "player", strength=strength)
        e0 = actor_of(core, sid, "player")["energy"]
        pv = prepare(core, sid, [atk("a1")], "e2e-" + degree)
        r = pv["outcome"]["resolutions"][0]
        c = r["check"].get("contribution") or {}
        margin = strength - BASE_DIFFICULTY
        chk("%s-①档位：strength=%d ⇒ margin=%d ⇒ %s" % (degree, strength, margin, degree),
            r["degree"] == degree and c.get("margin") == margin
            and c.get("degree") == degree, "r.degree=%s contrib=%s" % (r["degree"], c))
        chk("%s-②贡献拆解只读服务端（strength/defense/固定阻力/规则版本）" % degree,
            c.get("potency_strength") == strength and c.get("target_defense") == LIA_DEFENSE
            and c.get("base_resistance") == ATTACK_BASE_RESISTANCE
            and c.get("difficulty") == BASE_DIFFICULTY
            and c.get("energy_cost") == ATTACK_ENERGY_COST
            and c.get("formula") == "margin = strength - (defense + base_resistance)"
            and c.get("rule_version") == "fusion-rules-v1", str(c))
        rec = commit(core, sid, pv, "e2e-" + degree)
        op_state, tg_state = actor_of(core, sid, "player"), actor_of(core, sid, "lia")
        chk("%s-③所有已尝试档位扣 %d energy" % (degree, ATTACK_ENERGY_COST),
            op_state["energy"] == e0 - ATTACK_ENERGY_COST,
            "energy=%s→%s" % (e0, op_state["energy"]))
        chk("%s-④目标 balance_pressure +=%d（failure 不动）" % (degree, gain),
            tg_state["balance_pressure"] == gain,
            "lia.balance_pressure=%s" % tg_state["balance_pressure"])
        chk("%s-⑤行动者自身 balance_pressure +=%d" % (degree, self_gain),
            op_state["balance_pressure"] == self_gain,
            "player.balance_pressure=%s" % op_state["balance_pressure"])
        chk("%s-⑥整轮 result=%s" % (degree, result),
            rec["outcome"]["result"] == result and rec["outcome"]["degree"] == degree,
            "result=%s degree=%s" % (rec["outcome"]["result"], rec["outcome"]["degree"]))
        contest = [f for f in rec["outcome"]["facts_created"] if f.get("kind") == "contest"]
        chk("%s-⑦公开事实带 contest（margin/degree/目标失衡/耗能）" % degree,
            len(contest) == 1 and contest[0]["margin"] == margin
            and contest[0]["degree"] == degree
            and contest[0]["target_balance_pressure"] == gain
            and contest[0]["energy_spent"] == ATTACK_ENERGY_COST, str(contest))
        chk("%s-⑧回合记录只放公开描述符（type/kind/actor/target/degree/visibility）" % degree,
            rec["acts"] == [{"type": "attack", "kind": "challenge", "actor": "player",
                             "target": "lia", "degree": degree,
                             "visibility": "participants"}], str(rec["acts"]))
        want_opp = degree in DEGREE_SUCCESSFUL or degree == "partial_success"
        got_opp = [o for o in r["opportunities"] if o.get("kind") == "follow_up"]
        chk("%s-⑨Opportunity %s（只作下一轮建议）"
            % (degree, "存在" if want_opp else "不存在"),
            bool(got_opp) is want_opp, "opps=%s" % r["opportunities"])
        chk("%s-⑩world.turns 末条 result/degree 与回执一致" % degree,
            world_of(core, sid)["turns"][-1]["result"] == result
            and world_of(core, sid)["turns"][-1]["degree"] == degree, "")
        if degree == "critical_failure":
            chk("%s-⑪critical failure 记了自身失衡 complication" % degree,
                [x for x in r["complications"] if x["kind"] == "self_off_balance"]
                and r["costs"] == [{"kind": "energy", "actor": "player",
                                    "amount": ATTACK_ENERGY_COST}], str(r["complications"]))


# ------------------------------------------------------------------ D 截顶
def test_balance_pressure_cap():
    core, P, sid = fresh("b2b-cap")
    set_stats(sid, "player", strength=11)            # exceptional → +4
    set_inter(sid, "lia", balance_pressure=3)        # 目标已失衡 3（未到上限）
    e0 = actor_of(core, sid, "player")["energy"]
    pv = prepare(core, sid, [atk("a1")], "cap1")
    r = pv["outcome"]["resolutions"][0]
    rec = commit(core, sid, pv, "cap1")
    chk("D1-增量截顶：3+4 → 4（不越界）",
        actor_of(core, sid, "lia")["balance_pressure"] == BALANCE_PRESSURE_LIMIT,
        "bp=%s" % actor_of(core, sid, "lia")["balance_pressure"])
    chk("D2-截顶后仍是真实回合：扣 energy、推时钟、留 contest 事实",
        actor_of(core, sid, "player")["energy"] == e0 - ATTACK_ENERGY_COST
        and world_of(core, sid)["turn_tick"] == 1
        and [f for f in rec["outcome"]["facts_created"] if f["kind"] == "contest"], "")

    pv2 = prepare(core, sid, [atk("a1")], "cap2")
    r2 = pv2["outcome"]["resolutions"][0]
    commit(core, sid, pv2, "cap2")
    chk("D3-已达上限仍可再尝试：目标不再增长、但仍有真实消耗与回合事件",
        actor_of(core, sid, "lia")["balance_pressure"] == BALANCE_PRESSURE_LIMIT
        and actor_of(core, sid, "player")["energy"] == e0 - 2 * ATTACK_ENERGY_COST
        and world_of(core, sid)["turn_tick"] == 2
        and r2["execution_status"] == "attempted" and r2["degree"] == "exceptional_success", "")
    chk("D4-目标失衡为 0 增量的那一档不产生虚假 balance_pressure 写项",
        all(not ch["path"].endswith("balance_pressure")
            for ch in pv2["state_proposal"]["changes"] if ch["entity_id"] == "lia"), "")


# ------------------------------------------------------------------ E 注入
def test_client_injection():
    core, P, sid = fresh("b2b-inject")
    base = atk("a1")
    for field, value in (("difficulty", 1), ("margin", 99), ("degree", "exceptional_success"),
                         ("outcome", {"result": "achieved"}), ("delta", {"a.b": 1}),
                         ("success", True), ("state_delta", {})):
        bad = dict(base)
        bad[field] = value
        expect_error("E-注入 %s → 422（服务端唯一权威）" % field,
                     lambda b=bad, f=field: prepare(core, sid, [b], "inj-" + f),
                     "INVALID_REQUEST")
    bad = dict(base)
    bad["confidence"] = 0.9
    expect_error("E-未声明字段 confidence → 422（严格白名单）",
                 lambda: prepare(core, sid, [bad], "inj-conf"), "INVALID_REQUEST")
    bad = dict(base)
    bad["difficulty"] = 1
    expect_error("E-Commit 侧也无法补注入（Commit 只收候选引用 + 版本）",
                 lambda: core.commit({"session_id": sid, "event_id": "inj-c",
                                      "analysis_id": "x",
                                      "expected_versions": core.state(sid)["versions"],
                                      "difficulty": 1}), "INVALID_REQUEST")


# ------------------------------------------------------------------ F 重放与回滚
def test_replay_and_rollback():
    core, P, sid = fresh("b2b-replay")
    set_stats(sid, "player", strength=6)             # success
    pv = prepare(core, sid, [atk("a1")], "r1")
    r1 = commit(core, sid, pv, "r1")
    e1 = actor_of(core, sid, "player")["energy"]
    b1 = actor_of(core, sid, "lia")["balance_pressure"]
    t1 = world_of(core, sid)["turn_tick"]
    replay = commit(core, sid, pv, "r1")
    chk("F1-同 event 重放幂等：replayed=True、不二次扣 energy/失衡/时钟",
        replay.get("replayed") is True
        and actor_of(core, sid, "player")["energy"] == e1
        and actor_of(core, sid, "lia")["balance_pressure"] == b1
        and world_of(core, sid)["turn_tick"] == t1
        and len(world_of(core, sid)["turns"]) == 1, str(replay.get("replayed")))

    pv2 = prepare(core, sid, [atk("a1")], "r2")
    before_state = copy.deepcopy(B._ACTOR_STATE)
    before_versions = core.state(sid)["versions"]
    with mock.patch.object(B, "_STATE_TRACE", _BoomTrace()):
        expect_error("F2-发布段异常 → 500 全回退",
                     lambda: commit(core, sid, pv2, "r2"), "INTERNAL_ERROR")
    chk("F3-无半提交：energy/失衡/时钟/版本/事件表全回退",
        B._ACTOR_STATE == before_state
        and core.state(sid)["versions"] == before_versions
        and actor_of(core, sid, "player")["energy"] == e1
        and actor_of(core, sid, "lia")["balance_pressure"] == b1
        and world_of(core, sid)["turn_tick"] == t1
        and "r2" not in (P._events.get((sid, "player")) or {}), "")
    rec2 = commit(core, sid, pv2, "r2")
    chk("F4-回退后同一候选仍可正常提交",
        rec2["status"] == "committed"
        and actor_of(core, sid, "player")["energy"] == e1 - ATTACK_ENERGY_COST
        and world_of(core, sid)["turn_tick"] == t1 + 1, "commit_id=%s" % rec2["commit_id"])


# ------------------------------------------------------------------ B 非尝试 + G 聚合/依赖
def test_non_attempt_and_aggregation():
    core, P, sid = fresh("b2b-mode")
    e0 = actor_of(core, sid, "player")["energy"]
    pv = prepare(core, sid, [atk("a1", mode="negated")], "neg")
    r = pv["outcome"]["resolutions"][0]
    chk("B9-非尝试的 attack 记 skipped：degree=null、无 energy/失衡、无写项",
        r["execution_status"] == "skipped" and r["degree"] is None
        and r["changes"] == [] and pv["status"] == "blocked"
        and actor_of(core, sid, "player")["energy"] == e0, str(r["check"]["reasons"]))
    expect_error("B10-非尝试的 attack 不可提交",
                 lambda: commit(core, sid, pv, "neg"), "ANALYSIS_NOT_COMMITTABLE")

    # 聚合：attack(partial) + claim(success) → 整轮取最低档 partial_success
    core, P, sid = fresh("b2b-agg")
    set_stats(sid, "player", strength=5)
    pv = prepare(core, sid, [atk("a1"), claim("a2")], "agg")
    chk("G1-多动作一轮取最低档：attack(partial)+claim(success) → partial_success",
        pv["outcome"]["result"] == "partial_success"
        and pv["outcome"]["degree"] == "partial_success"
        and [x["execution_status"] for x in pv["outcome"]["resolutions"]]
        == ["attempted", "attempted"], "%s/%s" % (pv["outcome"]["result"],
                                                  pv["outcome"]["degree"]))

    # 依赖：成功类档位才满足 if_achieved
    core, P, sid = fresh("b2b-dep-hit")
    set_stats(sid, "player", strength=9)             # strong_success ∈ DEGREE_SUCCESSFUL
    pv = prepare(core, sid, [atk("a1"), look("a2", "cellar_door",
                                             depends_on="a1", when="if_achieved")], "dep-hit")
    chk("G2-strong_success 满足 if_achieved → 依赖动作执行",
        pv["outcome"]["resolutions"][1]["execution_status"] == "attempted", "")

    core, P, sid = fresh("b2b-dep-miss")
    set_stats(sid, "player", strength=5)             # partial_success ∉ DEGREE_SUCCESSFUL
    pv = prepare(core, sid, [atk("a1"), look("a2", "cellar_door",
                                             depends_on="a1", when="if_achieved")], "dep-miss")
    chk("G3-partial_success 不满足 if_achieved → 依赖动作 skipped、degree=null",
        pv["outcome"]["resolutions"][1]["execution_status"] == "skipped"
        and pv["outcome"]["resolutions"][1]["degree"] is None, "")


# ------------------------------------------------------------------ W 解释器接线
def test_interpreter_wiring():
    """P2-B2b-R1：固定响应、零云端的真实消费者链（玩家原文进入已实现的非致命规则）。

    这条链是 A 复审的合入阻断项：解释器闭集原先没有 `challenge`，提示词也把 `attack`
    一律描述成身体暴力，于是固定响应 `{"operation":"attack","kind":"challenge"}` 会被本地
    schema 判 `bad_kind`，真实玩家入口到不了已实现的六档规则。
    """
    chk("W0-解释器闭集含 challenge、提示词版本已升版",
        "challenge" in I.KINDS and I.PROMPT_VERSION != "p2a-prompt-v1",
        "kinds=%d prompt=%s" % (len(I.KINDS), I.PROMPT_VERSION))

    core, P, sid = fresh("b2b-wire")
    directory = I.build_entity_directory(core, sid)
    system, _user = I.build_interpret_prompt("我推搡莉亚", directory, "player")
    chk("W0b-提示词把 attack 定义为「非致命对抗( challenge )/伤害性暴力( violence )」并禁止 attack 带 object",
        "challenge" in system and "violence" in system
        and "attack 一律不给 object" in system, "")

    before = copy.deepcopy(B._ACTOR_STATE)
    raw = {"actions": [{"kind": "challenge", "operation": "attack",
                        "targets": ["莉亚"], "object": None, "mode": "attempt",
                        "evidence": ["我推搡莉亚"]}], "ambiguities": []}
    res = I.interpret_turn(core, sid, "我推搡莉亚", event_id="wire-1", caller=fake(raw))
    it = res["interpretation"]
    chk("W1-「我推搡莉亚」→ status=ready、operation=attack、kind=challenge、目标解析为 lia",
        it["status"] == "ready" and it["invalid_reason"] is None
        and res["prepare_error"] is None
        and it["actions"][0]["operation"] == "attack"
        and it["actions"][0]["kind"] == "challenge"
        and it["actions"][0]["target_ids"] == ["lia"], json.dumps(it, ensure_ascii=False)[:180])
    chk("W1b-解释结果标注真实提示词版本、且未用云端",
        it["source"]["caller"] == "injected"
        and it["source"]["prompt_version"] == I.PROMPT_VERSION, str(it["source"]))
    chk("W2-解释阶段零游戏写入", B._ACTOR_STATE == before, "")

    pv = core.prepare_structured(res["prepare_request"])
    chk("W3-解释器组装的 Prepare 请求可直接送核心（ready、贡献拆解出档位）",
        pv["status"] == "ready"
        and pv["outcome"]["resolutions"][0]["degree"] == "partial_success", str(pv["reason_codes"]))
    rec = core.commit({"session_id": sid, "event_id": "wire-1",
                       "analysis_id": pv["analysis_id"],
                       "expected_versions": pv["base_versions"]})
    st = core.state(sid)["states"]
    chk("W4-原话 → 意图 → Prepare → Commit 全链，下一轮读到 energy 与 balance_pressure 变化",
        rec["status"] == "committed"
        and st["player"]["interaction"]["energy"] == 8
        and st["lia"]["interaction"]["balance_pressure"] == 1
        and world_of(core, sid)["turn_tick"] == 1
        and rec["acts"][0]["degree"] == "partial_success",
        "energy=%s bp=%s" % (st["player"]["interaction"]["energy"],
                             st["lia"]["interaction"]["balance_pressure"]))

    # 反例 ①：伤害性暴力如实解释，但核心维持 UNSUPPORTED_OPERATION，状态零变化。
    core2, P2, sid2 = fresh("b2b-wire-violence")
    raw_v = {"actions": [{"kind": "violence", "operation": "attack",
                          "targets": ["莉亚"], "object": None, "mode": "attempt",
                          "evidence": ["我一拳打在莉亚脸上"]}], "ambiguities": []}
    res_v = I.interpret_turn(core2, sid2, "我一拳打在莉亚脸上", event_id="wire-v",
                             caller=fake(raw_v))
    chk("W5-violence 如实解释为 attack/violence，未被纠偏成 challenge",
        res_v["interpretation"]["status"] == "ready"
        and res_v["interpretation"]["coercions"] == []
        and res_v["interpretation"]["actions"][0]["kind"] == "violence", "")
    snap_v = copy.deepcopy(B._ACTOR_STATE)
    expect_error("W6-violence 不进结算 → 409 UNSUPPORTED_OPERATION",
                 lambda: core2.prepare_structured(res_v["prepare_request"]),
                 "UNSUPPORTED_OPERATION")
    chk("W7-violence 被拒后状态零变化、无回合事件",
        B._ACTOR_STATE == snap_v
        and core2.state(sid2)["states"]["player"]["interaction"]["energy"] == 10
        and core2.state(sid2)["states"]["lia"]["interaction"]["balance_pressure"] == 0
        and world_of(core2, sid2)["turn_tick"] == 0, "")

    # 反例 ②：带物品 attack 被核心拒绝，状态零变化（拒绝发生在核心，不靠解释器改写）。
    core3, P3, sid3 = fresh("b2b-wire-item")
    raw_i = {"actions": [{"kind": "challenge", "operation": "attack",
                          "targets": ["莉亚"], "object": "徽章", "mode": "attempt",
                          "evidence": ["我拿着徽章推搡莉亚"]}], "ambiguities": []}
    res_i = I.interpret_turn(core3, sid3, "我拿着徽章推搡莉亚", event_id="wire-i",
                             caller=fake(raw_i))
    chk("W8-带物品 attack 仍如实解释（operation=attack、object 解析为 badge）",
        res_i["interpretation"]["status"] == "ready"
        and res_i["interpretation"]["actions"][0]["operation"] == "attack"
        and res_i["interpretation"]["actions"][0]["object_id"] == "badge", "")
    snap_i = copy.deepcopy(B._ACTOR_STATE)
    expect_error("W9-带物品 attack → 409 UNSUPPORTED_OPERATION（不静默按徒手结算）",
                 lambda: core3.prepare_structured(res_i["prepare_request"]),
                 "UNSUPPORTED_OPERATION")
    chk("W10-带物品 attack 被拒后状态零变化、无回合事件",
        B._ACTOR_STATE == snap_i
        and core3.state(sid3)["states"]["player"]["interaction"]["energy"] == 10
        and core3.state(sid3)["states"]["lia"]["interaction"]["balance_pressure"] == 0
        and world_of(core3, sid3)["turn_tick"] == 0, "")

    # 反例 ③：隐喻威胁仍作交流，不因新增 challenge 而被转成角力。
    core4, P4, sid4 = fresh("b2b-wire-threat")
    raw_t = {"actions": [{"kind": "threat", "operation": "attack", "targets": [],
                          "object": None, "mode": "attempt",
                          "evidence": ["你最好祈祷太阳明天还升得起来"]}], "ambiguities": []}
    res_t = I.interpret_turn(core4, sid4, "你最好祈祷太阳明天还升得起来", event_id="wire-t",
                             caller=fake(raw_t))
    chk("W11-隐喻威胁仍被纠偏为交流（不得自动转为角力）",
        res_t["interpretation"]["actions"][0]["operation"] == "communicate"
        and res_t["interpretation"]["actions"][0]["kind"] == "threat"
        and res_t["interpretation"]["coercions"][0]["from"] == "attack", "")


# ------------------------------------------------------------------ H 规则边界
def test_rule_boundary():
    chk("H1-attack 已列入实现集、P2_OPERATIONS 已空",
        "attack" in IMPLEMENTED_OPERATIONS and P2_OPERATIONS == (),
        "implemented=%s p2=%s" % (list(IMPLEMENTED_OPERATIONS), list(P2_OPERATIONS)))
    core, P, sid = fresh("b2b-iso")
    pv = prepare(core, sid, [atk("a1")], "iso")
    chk("H2-rules_only=True 且 laya_evidence 为空（不伪称 Laya 参与）",
        pv["rules_only"] is True and pv["laya_evidence"] == []
        and pv["outcome"]["rules_only"] is True
        and pv["outcome"]["laya_evidence"] == [], "")
    chk("H3-同一进程内规则指纹稳定", core.rules_fingerprint() == core.rules_fingerprint(), "")


def main():
    test_degree_boundaries()
    test_kind_closed_set()
    test_hard_preconditions()
    test_six_degrees_end_to_end()
    test_balance_pressure_cap()
    test_client_injection()
    test_replay_and_rollback()
    test_non_attempt_and_aggregation()
    test_interpreter_wiring()
    test_rule_boundary()
    print("\nP2-B2b 六档对抗定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零模型、零云端、零 HTTP、零 Laya）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
