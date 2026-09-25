# -*- coding: utf-8 -*-
"""候选 B —— Action Resolver（任务书 §8，本轮最关键模块之一）。

回答：Actor 想做的事，最终**做到什么程度**。它消费结构化意图 + 事实验证 + 各种
显式因子，产出分级结果；它不写状态，也不写故事。

候选 B 的立场（自由语义 / AI Interaction 派）：
  - 语义自由归 Turn Interpreter（LLM），但**结果裁决完全是确定性的规则**，AI 不得
    参与「成不成功」的判断，更不得改数值 —— 这是 B 给「AI 自由」上的硬边界。
  - 不退回「关键词 → 固定数值」，也不退回「LLM 直接编结果」。本模块是**显式规则
    组合器**：Hard Rules 卡前提、stats/relationship/environment/Laya tendency/
    resources 各按公开权重进线性分，再按公开阈值映射到分级结果。
  - 是否随机**必须有明确理由**：默认不随机；只有调用方显式给 seed 并 allow_randomness
    才在单个档位带内加微小抖动，理由写死在文档里（防止「可被玩家背板」的确定性，
    而非为了复刻传统 RPG 骰子）。

分级（§8 要求的分级结构，等价可扩展）：
    critical_failure < failure < partial_success < success < strong_success
    < exceptional_success

同一套 resolve() 同时服务玩家与 NPC：能力分从各自的 stats 取，意图从各自的
TurnInterpretation 来，规则完全一致。

仅标准库（dataclasses / random）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from laya_facts import FactCheckReport

# ---------------------------------------------------------------------------
# 公开权重与阈值（常量，集中一处，便于审计与替换）
# ---------------------------------------------------------------------------
# 各因子对最终分（score ∈ [0,1]）的线性贡献权重。关系 / Laya 倾向 / 环境是
# [-1,1] 的有向修正，资源是 [0,1] 的增益。权重越小，该因子越接近「证据」而非
# 「主导」。这里刻意把 Laya 权重压低（它是 evidence，不是 authority）。
W_RELATIONSHIP = 0.15
W_LAYA = 0.10
W_ENVIRONMENT = 0.10
W_RESOURCE = 0.10
# 未知事实带来的不确定性惩罚：有 unknown（缺事实记录）时，对难度做小幅度上修。
UNKNOWN_PENALTY = 0.05
# 随机抖动幅度（仅在显式 allow_randomness 时生效），只覆盖单个档位带的一半宽度，
# 保证抖动不会跨档改变结果太多 —— 随机是「轻微调味」，不是「重新抽奖」。
JITTER = 0.03

# margin = score - difficulty，映射到分级。阈值是启发式定标，非测试凑数；
# 若后续要数据校准，改这一处即可（对应 §8「是否随机必须有明确理由」同一精神）。
_GRADE_BANDS = [
    (-1.0, "critical_failure"),
    (-0.25, "failure"),
    (0.0, "partial_success"),
    (0.20, "success"),
    (0.45, "strong_success"),
    (0.70, "exceptional_success"),
]

GRADES = [g for _, g in _GRADE_BANDS]  # 由低到高


def _grade_of(margin: float) -> str:
    result = "critical_failure"
    for thr, name in _GRADE_BANDS:
        if margin >= thr:
            result = name
    return result


# 语义意图 → 关联的 actor 能力键。这是**规则表**，不是关键词匹配：它只吃 TI 产出的
# 封闭意图枚举，绝不扫玩家原文。能力键由调用方在 ResolutionContext.actor_stats 提供。
INTENT_STATS = {
    "violence": ("strength", "combat"),
    "threat": ("intimidation", "presence"),
    "evidence_handover": ("sincerity", "credibility"),
    "information_handover": ("credibility", "eloquence"),
    "cooperation": ("sincerity", "reliability"),
    "apology": ("sincerity", "humility"),
    "hostility": ("intimidation", "presence"),
    "neutral": ("composure",),
    "question": ("perception", "eloquence"),
    "challenge": ("willpower", "presence"),
    "withdraw": ("agility",),
    "deceive": ("deception", "composure"),
    "reassure": ("sincerity", "empathy"),
    "comply": ("sincerity",),
    "refuse": ("willpower", "composure"),
}
# 意图的默认难度（0..1，越高越难）。调用方可用 context.difficulty 覆盖。
INTENT_DEFAULT_DIFFICULTY = {
    "violence": 0.55, "threat": 0.40, "evidence_handover": 0.30,
    "information_handover": 0.25, "cooperation": 0.30, "apology": 0.25,
    "hostility": 0.30, "neutral": 0.05, "question": 0.15, "challenge": 0.35,
    "withdraw": 0.20, "deceive": 0.50, "reassure": 0.30, "comply": 0.15,
    "refuse": 0.25,
}


# ---------------------------------------------------------------------------
# 数据对象（任务书 §15）
# ---------------------------------------------------------------------------
@dataclass
class LayaEvidence:
    """把基线 Laya 的结构化信号包成**只读证据**（§7：Laya 是 Proposal / Evidence，
    不是最终真相）。Resolver 只读其中少数倾向项，且权重很低；Laya 不能直接写状态。"""
    signals: dict = field(default_factory=dict)   # 原始信号读数（disclose/hostility/...）
    proposal_delta: list = field(default_factory=list)  # Laya 的 state proposal（仅审计）
    source: str = "laya"

    def get(self, name, default=0.0):
        return self.signals.get(name, default)

    def to_dict(self):
        return {"signals": dict(self.signals),
                "proposal_delta": list(self.proposal_delta), "source": self.source}


@dataclass
class ResolutionContext:
    """Resolver 的显式输入。拒绝一路传到底的巨型 dict（§15）。"""
    intent: str                              # 语义意图（封闭枚举）
    targets: list = field(default_factory=list)
    actor_stats: dict = field(default_factory=dict)     # {能力键: 0..1}
    target_stats: dict = field(default_factory=dict)
    relationship: dict = field(default_factory=dict)    # 只读，来自 Actor State
    environment: dict = field(default_factory=dict)     # {修饰名: -1..1}
    resources: dict = field(default_factory=dict)       # {资源名: 0..1 或 数量}
    difficulty: Optional[float] = None       # None → 用意图默认难度
    fact_report: Optional[FactCheckReport] = None
    laya: Optional[LayaEvidence] = None
    evidence: list = field(default_factory=list)        # 玩家原话逐字证据（审计）
    allow_randomness: bool = False
    seed: Any = None


@dataclass
class ActionResolution:
    """分级结果 + 全程可审计的判定依据。"""
    result: str                    # 六档之一
    degree: float                  # 归一化完成度 0..1（critical_failure≈0，exceptional≈1）
    score: float                   # 原始分（score-difficulty=margin）
    margin: float
    difficulty: float
    capability: float              # 综合能力分 0..1
    gate: Optional[str] = None     # 若被事实门拦截，记 gate 名（如 "fact_missing"）
    factors: list = field(default_factory=list)   # 每项因子的贡献，供 Debug Trace
    notes: list = field(default_factory=list)

    @property
    def succeeded(self) -> bool:
        return self.result in ("success", "strong_success", "exceptional_success")

    def to_dict(self):
        return {"result": self.result, "degree": self.degree, "score": self.score,
                "margin": self.margin, "difficulty": self.difficulty,
                "capability": self.capability, "gate": self.gate,
                "factors": list(self.factors), "notes": list(self.notes)}


# ---------------------------------------------------------------------------
# 因子计算（纯函数）
# ---------------------------------------------------------------------------
def _capability(intent: str, actor_stats: dict) -> float:
    """从意图关联的能力键聚合 actor 能力分。缺的键按 0.5 中性处理（不因缺数据而
    把玩家判成废物，也不判成超人）。"""
    keys = INTENT_STATS.get(intent, ("composure",))
    vals = [actor_stats.get(k) for k in keys]
    vals = [0.5 if v is None else v for v in vals]
    return sum(vals) / len(vals) if vals else 0.5


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _favor(relationship: dict) -> float:
    """关系修正 [-1,1]。从 trust 归一（trust 0..100 → -1..1）。缺字段 → 0。"""
    t = relationship.get("trust")
    if t is None:
        return 0.0
    return max(-1.0, min(1.0, (float(t) / 100.0) * 2.0 - 1.0))


def _laya_shift(laya: Optional[LayaEvidence]) -> float:
    """Laya 倾向修正 [-1,1]，只读 hostility/cooperation 两项，且是证据、权重低。"""
    if laya is None or laya.source != "laya" or not laya.signals:
        return 0.0
    coop = float(laya.get("cooperation", 0.0))
    host = float(laya.get("hostility", 0.0))
    # 合作 + 低敌意 → 正向；敌意 → 负向。映射到 [-1,1]。
    return max(-1.0, min(1.0, coop - host))


def _env_shift(environment: dict) -> float:
    """环境修正 [-1,1]，取调用方显式给出的命名词的加权平均。"""
    if not environment:
        return 0.0
    vals = [float(v) for v in environment.values()]
    return sum(vals) / len(vals) if vals else 0.0


def _resource_boost(resources: dict) -> float:
    """资源增益 [0,1]。取存在且非零的资源比例。"""
    if not resources:
        return 0.0
    return sum(1.0 for v in resources.values() if v) / len(resources)


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------
def resolve(ctx: ResolutionContext) -> ActionResolution:
    """把 ResolutionContext 解析成 ActionResolution。确定性、无副作用。

    顺序：
      1) 事实门：有 missing 前提 → 直接 failure（fail-forward 交给 Canonical Outcome）。
      2) 能力分：由意图关联的能力键聚合。
      3) 线性组合：capability + 关系 + Laya + 环境 + 资源，clamp 到 [0,1]。
      4) 难度：显式覆盖或意图默认；有 unknown 事实则上修 UNKNOWN_PENALTY。
      5) 可选随机：仅 allow_randomness 时 ±JITTER。
      6) margin → 六档。
    """
    factors = []

    # 1) 事实门：前提不满足，动作「不能按声称的方式」成功。绝不静默放行。
    report = ctx.fact_report
    if report is not None and report.has_missing():
        missing = report.missing()
        gate = "fact_missing"
        factors.append({"factor": "fact_gate", "value": "missing",
                        "detail": [m.rule_id for m in missing]})
        return ActionResolution(
            result="failure", degree=0.0, score=0.0, margin=-1.0,
            difficulty=ctx.difficulty if ctx.difficulty is not None
            else INTENT_DEFAULT_DIFFICULTY.get(ctx.intent, 0.3),
            capability=0.0, gate=gate, factors=factors,
            notes=["缺失事实前提：%s" % "、".join(m.description for m in missing)])

    # 2) 能力分
    cap = _capability(ctx.intent, ctx.actor_stats)
    factors.append({"factor": "capability", "value": round(cap, 3),
                    "detail": "intent=%s keys=%s" % (ctx.intent, INTENT_STATS.get(ctx.intent))})

    # 3) 各因子
    rel = _favor(ctx.relationship)
    laya = _laya_shift(ctx.laya)
    env = _env_shift(ctx.environment)
    res = _resource_boost(ctx.resources)
    for name, val, w in (("relationship", rel, W_RELATIONSHIP),
                         ("laya", laya, W_LAYA),
                         ("environment", env, W_ENVIRONMENT),
                         ("resource", res, W_RESOURCE)):
        factors.append({"factor": name, "value": round(val, 3),
                        "weight": w, "contrib": round(val * w, 3)})

    score = cap + W_RELATIONSHIP * rel + W_LAYA * laya + W_ENVIRONMENT * env + W_RESOURCE * res
    score = _clamp01(score)

    # 4) 难度
    difficulty = ctx.difficulty if ctx.difficulty is not None \
        else INTENT_DEFAULT_DIFFICULTY.get(ctx.intent, 0.3)
    n_unknown = len(report.unknown()) if report is not None else 0
    if n_unknown:
        difficulty = _clamp01(difficulty + UNKNOWN_PENALTY * n_unknown)
        ctx_notes = ["%d 项事实未知，难度上修 %s" % (n_unknown, UNKNOWN_PENALTY * n_unknown)]
    else:
        ctx_notes = []

    # 5) 可选随机（明确理由：调用方显式请求，防止确定性可背板；幅度受 JITTER 约束）
    if ctx.allow_randomness and ctx.seed is not None:
        import random
        jitter = (random.Random(ctx.seed).random() * 2 - 1) * JITTER
        score = _clamp01(score + jitter)
        factors.append({"factor": "random", "value": round(jitter, 3),
                        "weight": "seed=%r" % ctx.seed})

    # 6) 分级
    margin = score - difficulty
    result = _grade_of(margin)

    # 完成度归一：把 margin 映射到 [0,1]（critical_failure=0 端，exceptional=1 端）。
    degree = _clamp01((margin + 1.0) / 1.7)

    return ActionResolution(
        result=result, degree=round(degree, 3), score=round(score, 3),
        margin=round(margin, 3), difficulty=round(difficulty, 3),
        capability=round(cap, 3), gate=None, factors=factors,
        notes=ctx_notes + list(ctx.notes))


def resolve_intents(resolutions):
    """多意图取「最高完成度」的意图作为本轮主导结果（§4：一轮可多意图，但结算需收敛）。"""
    if not resolutions:
        return None
    return max(resolutions, key=lambda r: r.degree)
