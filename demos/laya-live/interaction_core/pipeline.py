"""Turn Tick 编排：Interpret → Facts → Laya → Resolve → Commit → Narrate（任务书 §13/§17）。

复用与边界：
  · 复用 laya_bridge.decide()（= analyze_core）拿 Laya 信号与引擎身份；
    它的 state_proposal 只作为**审计对照**（raw 通道），不再直接提交。
  · 复用协议层 propose_turn / commit_turn：版本冻结、事务、引擎门禁、
    session/actor 隔离、trace 全部继承 —— Interaction Core 不造第二套状态系统。
  · 状态写入的唯一来源是 Outcome.state_changes（resolver 裁决）；
    merge 时替换 Laya 原生 doubt_shift 条目（resolver 权威），
    其余可写信号保留 Laya 原生（经 capability 过滤，由 validate 层执行）。
  · NPC 回应行为从 Outcome 反推（npc_counter_intent → behaviors 映射，
    回落 Laya policy 行为）；两者皆无 → 本轮不提交（legacy 语义：
    歧义轮不是已确认事实），outcome 与 trace 照常返回。
"""
import copy as _copy
import time
from typing import Any, Dict, List, Optional

from . import facts as facts_mod
from . import interpreter, resolver
from .outcome import build_outcome
from .narration import narrate_from_outcome
from .schemas import (
    CommitOutcome,
    Degree,
    FactCheckResult,
    LayaEvidence,
    TurnInput,
    TurnResult,
)

# NPC 反制意图 → 现有 behaviors 的映射（CFG.behaviors: ask/observe/probe/leave/confide/ally/distance）
_NPC_BEHAVIOR_MAP = {
    "challenge": "probe",       # 要求验货/试探 → 试探追问
    "hostility": "distance",    # 对抗姿态 → 拉开距离
    "cooperation": "confide",   # 回以善意 → 吐露
    "question": "ask",
    "withdraw": "leave",
}


class _Ctx:
    """Turn 级共享上下文（trace 收集器 + 计时）。"""

    def __init__(self):
        self.trace: List[Dict[str, Any]] = []

    def step(self, layer: str, data: Dict[str, Any], t0: float) -> Dict[str, Any]:
        entry = {"layer": layer, "ms": round((time.perf_counter() - t0) * 1000, 1),
                 "data": data}
        self.trace.append(entry)
        return data


def _laya_evidence(decide_out: Dict[str, Any]) -> LayaEvidence:
    return LayaEvidence(
        signals=dict(decide_out.get("signal_values") or {}),
        engine=decide_out.get("engine") or "unknown",
        engine_ready=bool(decide_out.get("engine") == "laya"),
        raw_delta=list(((decide_out.get("state_proposal") or {}).get("delta")) or []))


def _target_stats(frozen_state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    st = frozen_state or {}
    rel = st.get("relationship") or {}
    emo = st.get("emotion") or {}
    return {"doubt": rel.get("doubt", 0.0), "trust": rel.get("trust", 0.0),
            "respect": rel.get("respect", 0.0),
            "alert": emo.get("alert", 0.0), "fondness": emo.get("fondness", 0.0)}


def merge_proposal(resolver_changes: List[Any], laya_raw_delta: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Outcome.state_changes（权威）与 Laya 原生增量的合并。

    规则：resolver 产出的信号（当前= doubt_shift）替换 Laya 同信号条目；
    其余信号保留 Laya 原生（capability 过滤由 validate 层统一执行）。
    审计字段走协议层**已透传**的通道（rule_adjudicated / adjudication_source /
    ti_basis）——不扩协议白名单，resolver 来源与理由随 commit 响应可见。
    """
    authoritative = {}
    delta: List[Dict[str, Any]] = []
    for c in resolver_changes:
        authoritative[c.source_signal] = True
        delta.append({
            "source_signal": c.source_signal, "target": c.target,
            "delta": c.delta, "status": "active", "grade": "A",
            "role": "state_shift", "label": "怀疑", "range": [0, 100],
            # ★ 审计透传（复用协议层已有字段，零白名单改动）
            "rule_adjudicated": c.resolved_by,          # resolver:<intent_type>
            "adjudication_source": "resolver",
            "ti_basis": [c.degree, (c.reason or "")[:120]],
        })
    for d in (laya_raw_delta or []):
        sig = d.get("source_signal")
        if sig in authoritative:
            continue                      # 该信号已被 resolver 裁决接管
        delta.append(_copy.deepcopy(d))
    return {"delta": delta}


def _npc_behavior_id(outcome, decide_out: Dict[str, Any], behaviors: List[Dict[str, Any]]) -> Optional[str]:
    """NPC 回应行为：Outcome 反推优先，回落 Laya policy；都无 → None（不提交）。"""
    known = {b.get("id") for b in (behaviors or [])}
    counter = resolver.npc_counter_intent(outcome, npc_name="")
    if counter is not None:
        bid = _NPC_BEHAVIOR_MAP.get(counter.type)
        if bid in known:
            return bid
    laya_bh = ((decide_out.get("policy") or {}).get("behavior"))
    if laya_bh in known:
        return laya_bh
    return None


def run_core_turn(B, payload: Dict[str, Any]) -> Dict[str, Any]:
    """完整 Turn Tick。B 是 laya_bridge 模块（显式依赖注入，便于测试 mock）。

    返回 TurnResult.to_dict()。
    """
    ctx = _Ctx()
    session_id = str(payload.get("session_id") or "default")
    actor = payload.get("actor") or B.CFG.get("actor")
    actor_id = str(payload.get("actor_id") or (actor or {}).get("name") or "default")
    npc_name = (actor or {}).get("name", "对方")
    player_input = str(payload.get("player_input") or payload.get("message") or "")
    turn_input = TurnInput(session_id=session_id, actor_id=actor_id,
                           player_input=player_input,
                           history=payload.get("history") or [],
                           scene=str(payload.get("scene") or ""))

    # ---- 0. 版本与快照冻结（协议层锁内；推理窗口内的 Reset/Commit 会让登记 409）----
    t0 = time.perf_counter()
    try:
        frozen_version, frozen_state = B.PROTOCOL.capture_legacy_scope(
            session_id, actor_id, actor=actor)
    except Exception as e:
        return TurnResult(ok=False, turn_id="", error="capture failed: %r" % e).to_dict()
    ctx.step("capture_scope", {"state_version": frozen_version}, t0)

    # ---- 1. Laya Evidence（复用 decide；fail-closed：翻译失败即中止本轮）----
    t0 = time.perf_counter()
    decide_payload = dict(payload, session_id=session_id, actor_id=actor_id)
    out = B.decide(decide_payload, frozen_state=frozen_state)
    if out.get("ok") is False or out.get("status") == "invalid":
        return TurnResult(ok=False, turn_id="",
                          error="laya invalid: %s" % out.get("invalid_reason")).to_dict()
    evidence = _laya_evidence(out)
    ctx.step("laya_evidence",
             {"engine": evidence.engine, "signals": evidence.signals,
              "raw_delta_n": len(evidence.raw_delta)}, t0)

    # ---- 2. Turn Interpretation（LLM 主通道 + Laya-only 降级链）----
    t0 = time.perf_counter()
    interp = interpreter.interpret_turn(player_input,
                                        laya_signals=evidence.signals,
                                        actor_name=npc_name)
    ctx.step("interpretation", interp.to_dict(), t0)

    # ---- 3. Facts / Hard Rules ----
    t0 = time.perf_counter()
    fact_results = facts_mod.check_facts(session_id, actor_id, interp.intents)
    # 登记：信息声明（供后续对账）与成立的事实
    for it in interp.intents:
        if it.type == "information_handover":
            facts_mod.add_claim(session_id, actor_id,
                                "、".join(it.objects) or "泛指信息")
    for f in (out.get("state_proposal") or {}).get("delta") or []:
        pass  # Laya raw 不登记事实（它只是倾向，不是真相）
    ctx.step("fact_checks", [f.to_dict() for f in fact_results], t0)

    # ---- 4. Action Resolution（玩家意图结算）----
    t0 = time.perf_counter()
    target_stats = _target_stats(frozen_state)
    resolutions = resolver.resolve_intents(
        interp.intents, fact_results, target_stats,
        laya=evidence, environment={"scene": turn_input.scene},
        actor_label="player",
        difficulty=float(payload.get("difficulty") or 0.0))
    ctx.step("resolutions", [r.to_dict() for r in resolutions], t0)

    # ---- 5. NPC 反制意图（共享模型演示：她也要"做事"，走同一套）----
    t0 = time.perf_counter()
    turn_id = "core_%s/%s#%d" % (session_id, actor_id, int(time.time() * 1000))
    outcome = build_outcome(turn_id, interp, resolutions, target_name=npc_name)
    counter = resolver.npc_counter_intent(outcome, npc_name=npc_name)
    npc_res = None
    if counter is not None:
        npc_fact = FactCheckResult(intent_ref=-1, verdict="ok")
        npc_res = resolver.resolve(resolver.ResolutionContext(
            intent=counter, fact=npc_fact,
            target_stats={"doubt": 0.0, "trust": 0.0, "alert": 0.0},   # 玩家侧简化
            laya=evidence, actor_label=npc_name))
    ctx.step("npc_counter",
             {"intent": counter.to_dict() if counter else None,
              "resolution": npc_res.to_dict() if npc_res else None}, t0)

    # ---- 6. Canonical Outcome（已含 state_changes 与 narration contract）----
    t0 = time.perf_counter()
    # outcome 已在 5 构建（此处登记 trace；facts_created 并入 FactBase 供后续轮对账）
    for f in outcome.facts_created:
        facts_mod.add_claim(session_id, actor_id, f)
    ctx.step("outcome", outcome.to_dict(), t0)

    # ---- 7. Validate / Commit（协议层；engine 门禁与版本检查全继承）----
    t0 = time.perf_counter()
    behavior_id = _npc_behavior_id(outcome, out, B.CFG.get("behaviors") or [])
    commit_out = CommitOutcome(committed=False,
                               note="本轮无 NPC 回应行为（歧义）→ 按协议不提交状态")
    if behavior_id is None:
        ctx.step("commit", {"skipped": True,
                            "reason": "no_behavior"}, t0)
    else:
        merged = merge_proposal(outcome.state_changes, evidence.raw_delta)
        try:
            B.propose_turn(
                turn_id, session_id, actor_id, behavior_id,
                (out.get("decision") or {}).get("player_intent", {}).get("id"),
                "interaction-core",
                state_proposal=merged,
                state_decision=(out.get("state_validation") or {}).get("decision") or {},
                actor=actor,
                engine_used=out.get("engine"),
                frozen_state=frozen_state, frozen_version=frozen_version)
        except Exception as e:
            return TurnResult(ok=False, turn_id=turn_id,
                              interpretation=interp, fact_checks=fact_results,
                              resolutions=resolutions, outcome=outcome,
                              error="propose failed: %r" % e,
                              trace=ctx.trace).to_dict()
        ok, note, state_result = B.commit_turn(turn_id)
        commit_out = CommitOutcome(
            committed=bool(ok), note=str(note),
            state_version=state_result.get("state_version"),
            commits=list(state_result.get("state_commits") or []),
            skipped=list(state_result.get("state_skipped") or []))
        ctx.step("commit", {"behavior": behavior_id, "ok": bool(ok),
                            "note": str(note), "state_version": commit_out.state_version,
                            "commits": commit_out.commits}, t0)

    # ---- 8. Story Agent（contract 驱动；use_llm=false 时跳过）----
    narration = None
    if payload.get("use_llm", True):
        t0 = time.perf_counter()
        n = narrate_from_outcome(outcome, player_input,
                                 dict(actor or {}), history=turn_input.history)
        narration = n
        ctx.step("narration", {"line": (n.get("line") or "")[:120],
                               "violations": n.get("contract_violations"),
                               "attempts": len(n.get("attempts") or [])}, t0)

    result = TurnResult(ok=True, turn_id=turn_id,
                        interpretation=interp, fact_checks=fact_results,
                        resolutions=resolutions, outcome=outcome,
                        commit=commit_out, narration=narration, trace=ctx.trace)
    return result.to_dict()
