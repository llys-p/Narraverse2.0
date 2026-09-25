"""Action Resolver：行动结算核心（任务书 §8，候选 C 的重点）。

回答一个问题：**Actor 想做的事，最终做到什么程度。**

结算模型（确定性，无骰子）：
    potency    = 行动力度 = base(意图) + 置信加成 + 资源/事实修正 + 环境加成
    difficulty = 对抗力度 = base(意图) + 目标状态修正 + 关系修正 + 显式难度
                 （false_claim 追加拆穿惩罚）
    margin     = potency - difficulty
    degree     = margin 的分级映射（6 档）

设计要点：
  · 纯函数：全部输入在 ResolutionContext，无隐藏全局状态，同输入同输出；
    未来要随机时以可注入 seed 的形式加，默认关闭（§8）。
  · 贡献分解：每个参与结算的因素都记录进 contributions（名字/数值/理由），
    Debug 模式能解释"为什么是 partial"（§16）。
  · Fail Forward 由 fail_forward() 独立承担：失败 ≠ 什么都没发生，
    产出 Cost / Complication / Opportunity（§9）。
  · 玩家与 NPC 共享同一 resolve()：结算主体只由 ctx.actor_label 区分，
    NPC 反制行动（如"要求验货"）走完全相同的模型。
  · Laya 是 Evidence 不是真相：信号只作为 potency/difficulty 的**修正项**
    （laya_support / alert 修正），不能直接决定 degree。
"""
from typing import Any, Dict, List, Optional

from .schemas import (
    ActionResolution,
    Degree,
    FactCheckResult,
    Intent,
    LayaEvidence,
    ResolutionContext,
)

# ----------------------------------------------------------------------------
# 数值定标（显式常量，供调参与审计；不藏在函数里）
# ----------------------------------------------------------------------------
BASE_POTENCY: Dict[str, float] = {
    "violence": 3.0, "threat": 2.5,
    "evidence_handover": 3.0, "information_handover": 2.5,
    "cooperation": 2.0, "apology": 2.0,
    "hostility": 1.5, "challenge": 1.5,
    "question": 0.0, "neutral": 0.0, "other": 0.0,
}
BASE_DIFFICULTY: Dict[str, float] = {
    "violence": 2.5, "threat": 2.0,
    "evidence_handover": 2.0, "information_handover": 2.5,
    "cooperation": 1.5, "apology": 1.0,
    "hostility": 0.5, "challenge": 1.0,
    "question": 0.0, "neutral": 0.0, "other": 0.5,
}

CONFIDENCE_WEIGHT = 2.0        # intent.confidence × 此值进 potency
FALSE_CLAIM_PENALTY = 5.0      # 声称交出没有的东西 → 极易被拆穿
INSUFFICIENT_PENALTY = 2.0     # 前提不足（缴械/无物件）→ 行动力度受损
LAYA_SUPPORT_MAX = 1.5         # Laya 一致性修正的幅度上限
DOUBT_DIFFICULTY_DIV = 20.0    # target.doubt 越高，让渡/说服越难
TRUST_DIFFICULTY_DIV = 25.0    # target.trust 越高，让渡/说服越容易
ALERT_WEIGHT = 3.0             # target.alert 越高，威胁/暴力越难奏效

# margin → degree 分级边界（有序，从低到高）
_DEGREE_BANDS = (
    (-4.5, Degree.CRITICAL_FAILURE),
    (-1.2, Degree.FAILURE),
    (0.8, Degree.PARTIAL_SUCCESS),
    (3.0, Degree.SUCCESS),
    (5.5, Degree.STRONG_SUCCESS),
)

# Laya 信号与意图方向的一致性表：intent → (支持信号, 反对信号)
_LAYA_ALIGNMENT: Dict[str, tuple] = {
    "information_handover": ("disclose", "hostility"),
    "evidence_handover": ("disclose", "hostility"),
    "cooperation": ("cooperation", "hostility"),
    "apology": ("cooperation", "hostility"),
    "threat": ("hostility", "cooperation"),
    "violence": ("hostility", "cooperation"),
    "hostility": ("hostility", "cooperation"),
    "challenge": ("confront", "cooperation"),
}


def _f(x, default=0.0) -> float:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return default
    return v if v == v and abs(v) != float("inf") else default


def degree_from_margin(margin: float) -> Degree:
    for bound, deg in _DEGREE_BANDS:
        if margin <= bound:
            return deg
    return Degree.EXCEPTIONAL_SUCCESS


# ----------------------------------------------------------------------------
# 结算主函数（玩家与 NPC 共用）
# ----------------------------------------------------------------------------
def resolve(ctx: ResolutionContext) -> ActionResolution:
    """结算一条意图。纯函数：ctx 不变、无副作用。"""
    itype = ctx.intent.type
    contribs: List[Dict[str, Any]] = []

    def add(name: str, value: float, why: str):
        contribs.append({"factor": name, "value": round(value, 3), "why": why})
        return value

    # ---- potency（行动力度）----
    potency = BASE_POTENCY.get(itype, 0.5)
    add("base_potency", potency, "意图基础力度 %s" % itype)

    conf_gain = ctx.intent.confidence * CONFIDENCE_WEIGHT
    potency += add("intent_confidence", conf_gain,
                   "表述置信 %.2f × %.1f" % (ctx.intent.confidence, CONFIDENCE_WEIGHT))
    if ctx.intent.source == "laya":
        # 降级链产物（无 objects/quote）——信息量低，力度打折（保守结算）
        potency -= add("degraded_interpretation", 1.0,
                       "解释来源为 laya-only（LLM 不可用），按保守结算")

    # 资源/环境对行动主体的加成（如"占上风的位置"）
    env_actor = _f((ctx.environment or {}).get("actor_advantage"))
    if env_actor:
        potency += add("environment_advantage", env_actor,
                       "环境给行动主体的加成")

    # ---- difficulty（对抗力度）----
    t = ctx.target_stats or {}
    difficulty = BASE_DIFFICULTY.get(itype, 0.5)
    add("base_difficulty", difficulty, "意图基础难度 %s" % itype)

    if itype in ("information_handover", "evidence_handover", "cooperation", "apology"):
        doubt_mod = _f(t.get("doubt")) / DOUBT_DIFFICULTY_DIV
        difficulty += add("target_doubt", doubt_mod,
                          "对方怀疑 %.0f / %.0f" % (_f(t.get("doubt")), DOUBT_DIFFICULTY_DIV))
        trust_mod = -_f(t.get("trust")) / TRUST_DIFFICULTY_DIV
        difficulty += add("target_trust", trust_mod,
                          "对方信任 %.0f / %.0f（降低难度）" % (_f(t.get("trust")), TRUST_DIFFICULTY_DIV))
    if itype in ("threat", "violence"):
        alert_mod = _f(t.get("alert")) * ALERT_WEIGHT
        difficulty += add("target_alert", alert_mod,
                          "对方警觉 %.2f × %.1f" % (_f(t.get("alert")), ALERT_WEIGHT))

    # Laya 一致性修正（evidence，不是真相）：支持信号高 → 行动更顺
    align = _LAYA_ALIGNMENT.get(itype)
    if align:
        sig = (ctx.laya.signals or {}) if ctx.laya else {}
        support, oppose = _f(sig.get(align[0])), _f(sig.get(align[1]))
        laya_mod = (support - oppose) * LAYA_SUPPORT_MAX
        if laya_mod:
            add("laya_alignment", laya_mod,
                "Laya 一致性（%s=%.2f, %s=%.2f）" % (align[0], support, align[1], oppose))
        difficulty -= laya_mod          # 支持度高 → 抵消难度

    # 事实裁决修正（硬规则通过 verdict 进入数值，不绕过 Resolver）
    verdict = ctx.fact.verdict
    if verdict == "false_claim":
        difficulty += add("false_claim", FALSE_CLAIM_PENALTY,
                          "声称交出未持有的物件，极易被拆穿")
    elif verdict == "insufficient":
        potency -= add("insufficient_preconditions", INSUFFICIENT_PENALTY,
                       "前提不足（缴械/无物件），行动降级")
    elif verdict == "denied":
        difficulty += add("hard_rule_denied", 10.0, "硬规则禁止（束缚/失能），几乎不可能成功")

    # 显式难度（调用方注入，如"她此刻握着剑"）
    if ctx.difficulty:
        difficulty += add("explicit_difficulty", _f(ctx.difficulty), "调用方注入的难度")

    margin = potency - difficulty
    degree = degree_from_margin(margin)
    rationale = "%s 结算：力度 %.1f vs 难度 %.1f（margin %.1f）→ %s" % (
        itype, potency, difficulty, margin, degree.label)
    return ActionResolution(
        intent_ref=0, degree=degree, margin=round(margin, 3),
        potency=round(potency, 3), difficulty_total=round(difficulty, 3),
        contributions=contribs, rationale=rationale)


def resolve_intents(intents: List[Intent], fact_results: List[FactCheckResult],
                    target_stats: Dict[str, Any],
                    laya: Optional[LayaEvidence] = None,
                    environment: Optional[Dict[str, Any]] = None,
                    actor_label: str = "player",
                    actor_stats: Optional[Dict[str, Any]] = None,
                    difficulty: float = 0.0) -> List[ActionResolution]:
    """批量结算（一轮多意图）。intent 与 fact 按 index 对齐（facts.check_facts 保证）。"""
    out = []
    for idx, intent in enumerate(intents):
        fact = fact_results[idx] if idx < len(fact_results) else FactCheckResult(
            intent_ref=idx, verdict="ok")
        ctx = ResolutionContext(
            intent=intent, fact=fact,
            actor_stats=actor_stats or {}, target_stats=dict(target_stats or {}),
            environment=dict(environment or {}),
            laya=laya or LayaEvidence(),
            difficulty=difficulty, actor_label=actor_label)
        res = resolve(ctx)
        res.intent_ref = idx
        out.append(res)
    return out


# ----------------------------------------------------------------------------
# NPC 行动（共享模型）：从 Outcome 的 complication / opportunity 生成 NPC 意图，
# 走同一 resolve()。第一版覆盖最典型的反制：要求验货 / 试探追问 / 后撤防御。
# ----------------------------------------------------------------------------
def npc_counter_intent(outcome, npc_name: str) -> Optional[Intent]:
    """根据已发生的 Outcome 为 NPC 生成一条反制意图（共享行动模型入口）。

    规则语义级（基于 outcome 字段，非文本匹配）：
      · 让渡类 partial/failure + complication 含"验" → NPC 发起 challenge（要求验货）
      · threat/violence success → NPC 发起 hostility（对抗姿态）或 withdraw（后撤）
      · exceptional handover → NPC 发起 cooperation（回以善意）
    """
    if outcome is None:
        return None
    primary = outcome.primary_intent
    deg = outcome.degree
    complications = " ".join(outcome.complications or "")
    if primary in ("evidence_handover", "information_handover"):
        if deg >= Degree.STRONG_SUCCESS:
            return Intent(type="cooperation", targets=["player"],
                          confidence=0.7, source="npc_reflex",
                          quote="回以善意")
        if "验" in complications or "查证" in complications:
            return Intent(type="challenge", targets=["player"],
                          confidence=0.8, source="npc_reflex",
                          quote="要求当场验货")
        if deg <= Degree.FAILURE:
            return Intent(type="hostility", targets=["player"],
                          confidence=0.6, source="npc_reflex",
                          quote="对失败的说辞保持敌意")
    if primary in ("threat", "violence"):
        if deg >= Degree.SUCCESS:
            return Intent(type="hostility", targets=["player"],
                          confidence=0.75, source="npc_reflex",
                          quote="威胁奏效后的对抗姿态")
        if deg <= Degree.FAILURE:
            return Intent(type="challenge", targets=["player"],
                          confidence=0.7, source="npc_reflex",
                          quote="看穿虚张声势，反过来试探")
    return None
