"""冻结的核心数据对象（任务书 §15）。

设计原则：
  · 显式 schema、可序列化（to_dict）、不可变语义（构建后调用方不改字段；
    frozen dataclass 会阻碍 deepcopy/mock 测试，改用"约定 + 深拷贝出口"）；
  · 每个对象携带自己的 trace 元数据（source / confidence / reasons），
    任何一层都能回答"这个值从哪来"；
  · 不允许一个无边界的 dict 从第一层传到底 —— 层与层之间只传这些类型。
"""
from dataclasses import dataclass, field
from enum import IntEnum
from typing import Any, Dict, List, Optional


class Degree(IntEnum):
    """行动结算分级（任务书 §8：不要只支持 true/false）。

    数值有序，便于比较与映射；语义命名保持 RPG 惯例但不绑骰子。
    """

    CRITICAL_FAILURE = -2   # 行动失败且引发反噬（被识破、受伤、关系崩塌）
    FAILURE = -1            # 行动没有达成
    PARTIAL_SUCCESS = 0     # 部分达成 / 打折扣的达成
    SUCCESS = 1             # 达成
    STRONG_SUCCESS = 2      # 显著超出预期
    EXCEPTIONAL_SUCCESS = 3 # 完美达成并留下额外机会

    @property
    def label(self) -> str:
        return _DEGREE_LABELS[self]


_DEGREE_LABELS = {
    Degree.CRITICAL_FAILURE: "critical_failure",
    Degree.FAILURE: "failure",
    Degree.PARTIAL_SUCCESS: "partial_success",
    Degree.SUCCESS: "success",
    Degree.STRONG_SUCCESS: "strong_success",
    Degree.EXCEPTIONAL_SUCCESS: "exceptional_success",
}


def _deg(x) -> str:
    return x.label if isinstance(x, Degree) else str(x)


# ----------------------------------------------------------------------------
# 0. 输入
# ----------------------------------------------------------------------------
@dataclass
class TurnInput:
    """一轮交互的原始输入。Interpreter 之前的唯一载体。"""

    session_id: str
    actor_id: str                 # 本轮"对手"NPC（目标状态桶）
    player_input: str
    history: List[Dict[str, str]] = field(default_factory=list)
    scene: str = ""
    actor_identities: Dict[str, str] = field(default_factory=dict)  # 名字→身份备注（多目标归一用）
    tick: str = "turn"            # turn / scene / world（时间尺度预留，§13）

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id, "actor_id": self.actor_id,
            "player_input": self.player_input, "history": list(self.history),
            "scene": self.scene, "tick": self.tick,
        }


# ----------------------------------------------------------------------------
# 1. Turn Interpretation
# ----------------------------------------------------------------------------
# 语义类别白名单：Interpreter 唯一允许输出的类别（防 LLM 幻觉字段）。
INTENT_TYPES = (
    "violence",              # 直接动手（攻击、夺、强闯）
    "threat",                # 言语/姿态威胁（含隐喻威胁）
    "evidence_handover",     # 交出/出示实物证据
    "information_handover",  # 交代信息、坦白、指路（不需要实物）
    "cooperation",           # 主动配合、示好、提供帮助
    "apology",               # 道歉、退让、软化
    "hostility",             # 敌意表达（不构成威胁的敌对态度）
    "question",              # 提问、探询
    "challenge",             # 激将、质问、挑衅（要求对方证明/回应）
    "neutral",               # 中性/闲聊
    "other",                 # 以上都不匹配（保留，不许滥用：见 interpreter 校验）
)


@dataclass
class Intent:
    """单条结构化意图。一轮可有多条（§4：不强迫 one turn = one intent）。"""

    type: str                      # INTENT_TYPES 之一
    targets: List[str] = field(default_factory=list)   # 行为指向（NPC 名 / "player"）
    objects: List[str] = field(default_factory=list)   # 涉及物件（徽章、钥匙、刀…）
    tone: List[str] = field(default_factory=list)      # impatient / mocking / sincere…
    confidence: float = 0.5        # Interpreter 对该意图的置信（0~1）
    source: str = "llm"            # llm | laya | degraded
    quote: str = ""                # 支撑该判断的原文片段（审计用）

    def to_dict(self) -> Dict[str, Any]:
        return {"type": self.type, "targets": list(self.targets),
                "objects": list(self.objects), "tone": list(self.tone),
                "confidence": round(self.confidence, 3), "source": self.source,
                "quote": self.quote}


@dataclass
class TurnInterpretation:
    """Interpreter 的完整输出：这轮玩家实际尝试做了什么。"""

    text: str
    intents: List[Intent] = field(default_factory=list)
    tone: List[str] = field(default_factory=list)      # 整体语气
    source: str = "llm"                                # llm | laya_only | neutral_fallback
    notes: List[str] = field(default_factory=list)     # 冲突/降级说明（审计）

    def to_dict(self) -> Dict[str, Any]:
        return {"text": self.text, "intents": [i.to_dict() for i in self.intents],
                "tone": list(self.tone), "source": self.source,
                "notes": list(self.notes)}

    def intents_of(self, *types: str) -> List[Intent]:
        return [i for i in self.intents if i.type in types]


# ----------------------------------------------------------------------------
# 2. Facts / Hard Rules
# ----------------------------------------------------------------------------
@dataclass
class FactCheckResult:
    """单条意图的事实验证结果（§6）。

    verdict:
      ok           —— 前提成立，可按原意结算
      insufficient —— 前提不足（缺资源/缺权限），行动要降级结算
      false_claim  —— 与已知事实矛盾（声称交出没有的物品）→ 反噬通道
      denied       —— 硬规则禁止（被束缚、门不存在）
    """

    intent_ref: int                # 对应 intents 下标
    verdict: str                   # ok | insufficient | false_claim | denied
    reasons: List[str] = field(default_factory=list)
    facts_used: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {"intent_ref": self.intent_ref, "verdict": self.verdict,
                "reasons": list(self.reasons), "facts_used": dict(self.facts_used)}


# ----------------------------------------------------------------------------
# 3. Laya Evidence
# ----------------------------------------------------------------------------
@dataclass
class LayaEvidence:
    """Laya 的信号读数 —— Proposal / Evidence，不是世界真相（§7）。

    signals: 9 个结构化信号（hostility/cooperation/withdraw/confront/disclose/
             investigate/trust/doubt/danger），prob 量纲 0~1
    raw_delta: Laya 原始数值建议（capability 过滤前），仅供审计
    """

    signals: Dict[str, float] = field(default_factory=dict)
    engine: str = "laya"
    engine_ready: bool = True
    raw_delta: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {"signals": dict(self.signals), "engine": self.engine,
                "engine_ready": self.engine_ready,
                "raw_delta": list(self.raw_delta)}


# ----------------------------------------------------------------------------
# 4. Resolution
# ----------------------------------------------------------------------------
@dataclass
class ResolutionContext:
    """Resolver 的全部输入（§8）。纯数据、显式依赖：同输入 → 同输出。"""

    intent: Intent
    fact: FactCheckResult
    actor_stats: Dict[str, Any] = field(default_factory=dict)    # 玩家侧重性状态（来自关系/事实）
    target_stats: Dict[str, Any] = field(default_factory=dict)   # NPC relationship/emotion
    environment: Dict[str, Any] = field(default_factory=dict)    # scene 修正
    laya: LayaEvidence = field(default_factory=LayaEvidence)
    difficulty: float = 0.0           # 显式难度修正（调用方注入，如"她此刻握着剑"）
    resources: Dict[str, Any] = field(default_factory=dict)      # 资源/物品
    actor_label: str = "player"       # 结算主体（player 或 NPC 名 —— 共享模型）

    def to_dict(self) -> Dict[str, Any]:
        return {"intent": self.intent.to_dict(), "fact": self.fact.to_dict(),
                "actor_stats": dict(self.actor_stats), "target_stats": dict(self.target_stats),
                "environment": dict(self.environment), "laya": self.laya.to_dict(),
                "difficulty": self.difficulty, "resources": dict(self.resources),
                "actor_label": self.actor_label}


@dataclass
class ActionResolution:
    """单条意图的结算结果：做到什么程度、为什么。"""

    intent_ref: int
    degree: Degree
    margin: float                        # potency - difficulty（原始差值，审计）
    potency: float
    difficulty_total: float
    contributions: List[Dict[str, Any]] = field(default_factory=list)  # 每个因素的名/值/理由
    rationale: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"intent_ref": self.intent_ref, "degree": _deg(self.degree),
                "margin": round(self.margin, 3), "potency": round(self.potency, 3),
                "difficulty_total": round(self.difficulty_total, 3),
                "contributions": list(self.contributions), "rationale": self.rationale}


# ----------------------------------------------------------------------------
# 5. Canonical Outcome
# ----------------------------------------------------------------------------
@dataclass
class StateChange:
    """经裁决的状态变化提案（唯一权威来源是 Outcome，不是 Laya raw delta）。"""

    source_signal: str        # 进既有 state_transition 的信号名（如 doubt_shift）
    target: str               # 状态路径（如 relationship.doubt）
    delta: float
    reason: str               # 为什么变（审计 + narration 依据）
    resolved_by: str          # 产生它的意图类型（resolver:<intent>）
    degree: str = ""          # 结算档位

    def to_dict(self) -> Dict[str, Any]:
        return {"source_signal": self.source_signal, "target": self.target,
                "delta": round(self.delta, 3), "reason": self.reason,
                "resolved_by": self.resolved_by, "degree": self.degree}


@dataclass
class NarrationContract:
    """Story Agent 的边界（§11）：可写什么、不可写什么。

    must_include  —— 台词必须体现的事实（degree 与关键结果）
    may_include   —— 允许自由发挥的表现空间
    must_not_include —— 语义禁区（短语级，供输出校验）
    """

    must_include: List[str] = field(default_factory=list)
    may_include: List[str] = field(default_factory=list)
    must_not_include: List[str] = field(default_factory=list)
    state_summary: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"must_include": list(self.must_include),
                "may_include": list(self.may_include),
                "must_not_include": list(self.must_not_include),
                "state_summary": self.state_summary}


@dataclass
class CanonicalOutcome:
    """本轮唯一权威世界事实（§9）。Validate+Commit 后不可被任何层改写。"""

    turn_id: str
    primary_intent: str                 # 主意图类型（多意图时按结算优先级取主）
    result: str                         # 面向叙事的一句话结论（权威）
    degree: Degree
    degrees: Dict[str, str] = field(default_factory=dict)   # intent_type → degree（多意图）
    facts_created: List[str] = field(default_factory=list)
    state_changes: List[StateChange] = field(default_factory=list)
    costs: List[str] = field(default_factory=list)
    complications: List[str] = field(default_factory=list)
    opportunities: List[str] = field(default_factory=list)
    narration_contract: NarrationContract = field(default_factory=NarrationContract)

    def to_dict(self) -> Dict[str, Any]:
        return {"turn_id": self.turn_id, "primary_intent": self.primary_intent,
                "result": self.result, "degree": _deg(self.degree),
                "degrees": dict(self.degrees),
                "facts_created": list(self.facts_created),
                "state_changes": [c.to_dict() for c in self.state_changes],
                "costs": list(self.costs), "complications": list(self.complications),
                "opportunities": list(self.opportunities),
                "narration_contract": self.narration_contract.to_dict()}


# ----------------------------------------------------------------------------
# 6. Commit / Turn Result
# ----------------------------------------------------------------------------
@dataclass
class CommitOutcome:
    """既有 Validate/Commit 入口的回执（协议层，透传不重造）。"""

    committed: bool
    state_version: Optional[str] = None
    commits: List[Dict[str, Any]] = field(default_factory=list)
    skipped: List[Dict[str, Any]] = field(default_factory=list)
    note: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {"committed": self.committed, "state_version": self.state_version,
                "commits": list(self.commits), "skipped": list(self.skipped),
                "note": self.note}


@dataclass
class TurnResult:
    """完整 Turn Tick 的返回（含全链路 debug trace，§16）。"""

    ok: bool
    turn_id: str
    interpretation: Optional[TurnInterpretation] = None
    fact_checks: List[FactCheckResult] = field(default_factory=list)
    resolutions: List[ActionResolution] = field(default_factory=list)
    outcome: Optional[CanonicalOutcome] = None
    commit: Optional[CommitOutcome] = None
    narration: Optional[Dict[str, Any]] = None       # {line, contract_check, ...}
    trace: List[Dict[str, Any]] = field(default_factory=list)   # 每层 {layer, ms, data}
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok, "turn_id": self.turn_id,
            "interpretation": self.interpretation.to_dict() if self.interpretation else None,
            "fact_checks": [f.to_dict() for f in self.fact_checks],
            "resolutions": [r.to_dict() for r in self.resolutions],
            "outcome": self.outcome.to_dict() if self.outcome else None,
            "commit": self.commit.to_dict() if self.commit else None,
            "narration": self.narration,
            "trace": list(self.trace),
            "error": self.error,
        }


# ----------------------------------------------------------------------------
# 7. 未来扩展的预留对象（§12 Director / Memory —— 本轮只立 schema 不实现）
# ----------------------------------------------------------------------------
@dataclass
class NarrativePressure:
    """Cloud Director 的低频输出（预留）：影响机会/压力，不覆盖已 Resolve 的结果。"""

    kind: str = "pressure"            # pressure | agenda | opportunity | threat | goal | hold
    payload: Dict[str, Any] = field(default_factory=dict)
    expires_at_tick: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        return {"kind": self.kind, "payload": dict(self.payload),
                "expires_at_tick": self.expires_at_tick}


@dataclass
class RelevantMemory:
    """相关记忆（预留）：Interpreter / Resolver 的上下文补充。"""

    actor_id: str
    summary: str
    relevance: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {"actor_id": self.actor_id, "summary": self.summary,
                "relevance": round(self.relevance, 3)}
