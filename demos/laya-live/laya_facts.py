# -*- coding: utf-8 -*-
"""候选 B —— Facts / Hard Rules 模块（任务书 §6）。

定位：Turn Interpretation 之后、Action Resolver 之前的一层「事实验证」，回答
「玩家这一轮想做的那件事，在当前世界里**是否具备前提**」。

为什么必须有这一层（候选 B 的自由语义反而最需要它）：
  B 把语义理解交给了 LLM，玩家「不用说开发者预期的话也能被读懂」。但理解越自由，
  越需要一道**权威的事实边界**挡住理解之外的东西 —— 玩家说自己「拿钥匙开门」，
  语义层能读懂 intent=cooperation 或某种开门动作，但**有没有钥匙**、**门是否存在**、
  **门是否已开**，是 AI 不该也不该有权随口定的。这些必须来自 world 层事实。

设计原则（与 B 的「AI 自由 / 规则权威」一致）：
  1. 事实只来自 WorldState（session/actor 隔离的显式结构），绝不来自 LLM 输出。
  2. 每条 HardRule 是**纯函数**：输入规则 + 世界 + 行动者 + 目标 → FactCheckResult，
     无副作用、无隐藏全局、可单测。
  3. 检查结果是三态（satisfied / missing / unknown），不是布尔：缺证据时宁可
     「unknown」交给 Resolver 按可配置策略处理，也不偷偷猜成「满足」。
  4. 本轮不实现完整 RPG Rules Engine（任务书 §19），只提供**干净的接口 + 几个
     基础规则**，证明力量/负重/技能/装备/位置/距离/资源/所有权/伤势/环境这些
     输入能被权威地约束结算；具体规则后续按需扩。

仅标准库（dataclasses）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional


# ---------------------------------------------------------------------------
# 事实域（§6 列举的 Hard Rules 承载项）
# ---------------------------------------------------------------------------
FACT_DOMAINS = (
    "inventory",     # 物品所有权 / 持有
    "equipment",     # 装备
    "skill",         # 技能
    "strength",      # 力量 / 负重
    "location",      # 位置 / 距离
    "condition",     # 伤势 / 失能 / 束缚
    "resource",      # 资源（金钱、耗材等）
    "environment",   # 环境与世界事实
    "relationship",  # 关系事实（只读，来自 Actor State）
)


@dataclass
class WorldFact:
    """一条世界事实。world 层权威，只能由 init / Validate-Commit 写入，AI 只读。"""
    key: str                 # 事实键，如 "inventory:player:cell_key"
    value: Any
    domain: str = "environment"
    source: str = "init"     # init | commit | rule_derived
    note: str = ""

    def to_dict(self):
        return {"key": self.key, "value": self.value, "domain": self.domain,
                "source": self.source, "note": self.note}


@dataclass
class WorldState:
    """某 session/actor 视角下的世界事实（显式依赖，不藏在模块级全局里）。

    与基线的 Actor State 正交：Actor State 存 relationship/emotion/goals 等**人物状态**，
    WorldState 存**物品 / 位置 / 环境 / 所有权**等客观事实。二者都按 (session_id,
    actor_id) 隔离，但这里刻意不接任何全局 store —— 由上层（InteractionCore）负责
    从持久化里取出来显式传入，保证函数可测、无隐藏状态。
    """
    session_id: str
    actor_id: str
    facts: dict = field(default_factory=dict)        # key -> WorldFact.value
    domains: dict = field(default_factory=dict)      # key -> domain（冗余加速查找）

    def get(self, key, default=None):
        return self.facts.get(key, default)

    def has(self, key) -> bool:
        return key in self.facts

    def set(self, key, value, domain="environment", source="init", note=""):
        self.facts[key] = value
        self.domains[key] = domain
        return self

    def to_dict(self):
        return {"session_id": self.session_id, "actor_id": self.actor_id,
                "facts": {k: {"value": v, "domain": self.domains.get(k)} for k, v in self.facts.items()}}


# ---------------------------------------------------------------------------
# 事实检查结果
# ---------------------------------------------------------------------------
@dataclass
class FactCheckResult:
    """单条事实检查的结论。三态，非布尔。"""
    rule_id: str
    status: str            # "satisfied" | "missing" | "unknown"
    description: str       # 检查了什么
    required: Any = None   # 需要的前提值（若可描述）
    found: Any = None      # 当前世界里的实际值
    reason: str = ""       # 为什么是这个结论

    @property
    def ok(self) -> bool:
        return self.status == "satisfied"

    def to_dict(self):
        return {"rule_id": self.rule_id, "status": self.status,
                "description": self.description, "required": self.required,
                "found": self.found, "reason": self.reason}


# ---------------------------------------------------------------------------
# HardRule 与检查器
# ---------------------------------------------------------------------------
@dataclass
class HardRule:
    """一条可审计的硬规则：rule_id 唯一、description 可读、check 是纯函数。

    check 签名：check(world: WorldState, actor, target) -> FactCheckResult
    actor/target 是上层解析出的实体（可为 None）。
    """
    rule_id: str
    description: str
    check: Callable[[WorldState, Any, Any], FactCheckResult]

    def run(self, world, actor=None, target=None) -> FactCheckResult:
        try:
            return self.check(world, actor, target)
        except Exception as e:  # 规则自身异常不得漏过，显式转成 unknown 并记 reason
            return FactCheckResult(self.rule_id, "unknown", self.description,
                                   reason="rule_error:%s" % type(e).__name__)


@dataclass
class FactCheckReport:
    """一组事实检查的汇总。Resolver 据此决定可行性与难度修正。"""
    checks: list = field(default_factory=list)

    def add(self, result: FactCheckResult):
        self.checks.append(result)
        return self

    def all_ok(self) -> bool:
        return bool(self.checks) and all(c.ok for c in self.checks)

    def has_missing(self) -> bool:
        return any(c.status == "missing" for c in self.checks)

    def missing(self):
        return [c for c in self.checks if c.status == "missing"]

    def unknown(self):
        return [c for c in self.checks if c.status == "unknown"]

    def to_dict(self):
        return [c.to_dict() for c in self.checks]


# ---------------------------------------------------------------------------
# 基础硬规则（§6 举例的实现；接口是重点，规则数量不设限）
# ---------------------------------------------------------------------------
def rule_owned_item(item_key: str, holder: str = "player") -> HardRule:
    """玩家必须拥有某物品。"""
    def _check(world, actor, target):
        key = "inventory:%s:%s" % (holder, item_key)
        desc = "持有物品 %s" % item_key
        if not world.has(key):
            return FactCheckResult("owned_item:%s" % item_key, "missing", desc,
                                   required=True, found=None,
                                   reason="世界里没有记录 %s 持有 %s" % (holder, item_key))
        held = world.get(key) is True
        return FactCheckResult("owned_item:%s" % item_key,
                               "satisfied" if held else "missing", desc,
                               required=True, found=world.get(key),
                               reason="" if held else "该物品不由行动者持有")
    return HardRule("owned_item:%s" % item_key, "持有物品 %s" % item_key, _check)


def rule_item_match(item_key: str, expected: Any) -> HardRule:
    """持有的物品必须匹配预期（如钥匙是否匹配锁）。"""
    def _check(world, actor, target):
        desc = "物品 %s 匹配预期 %r" % (item_key, expected)
        found = world.get("inventory:player:%s" % item_key)
        if found is None:
            return FactCheckResult("item_match:%s" % item_key, "missing", desc,
                                   required=expected, found=found,
                                   reason="未持有 %s，无法比对" % item_key)
        ok = (found == expected) if not isinstance(expected, set) else (found in expected)
        return FactCheckResult("item_match:%s" % item_key,
                               "satisfied" if ok else "missing", desc,
                               required=expected, found=found,
                               reason="" if ok else "持有值 %r 与预期 %r 不匹配" % (found, expected))
    return HardRule("item_match:%s" % item_key, "物品 %s 匹配预期" % item_key, _check)


def rule_target_exists(target_key: str) -> HardRule:
    """目标实体必须存在。"""
    def _check(world, actor, target):
        desc = "目标 %s 存在" % target_key
        if world.has("entity:%s" % target_key):
            return FactCheckResult("target_exists:%s" % target_key, "satisfied", desc,
                                   required=True, found=True)
        return FactCheckResult("target_exists:%s" % target_key, "missing", desc,
                               required=True, found=False, reason="目标 %s 不存在" % target_key)
    return HardRule("target_exists:%s" % target_key, "目标 %s 存在" % target_key, _check)


def rule_target_state(target_key: str, attr: str, expected: Any) -> HardRule:
    """目标实体的某属性必须等于/属于预期（如「门必须尚未打开」）。"""
    def _check(world, actor, target):
        desc = "目标 %s 的 %s == %r" % (target_key, attr, expected)
        found = world.get("entity:%s:%s" % (target_key, attr))
        if found is None:
            return FactCheckResult("target_state:%s.%s" % (target_key, attr), "unknown",
                                   desc, required=expected, found=found,
                                   reason="目标 %s 的 %s 属性未知" % (target_key, attr))
        ok = (found == expected) if not isinstance(expected, set) else (found in expected)
        return FactCheckResult("target_state:%s.%s" % (target_key, attr),
                               "satisfied" if ok else "missing", desc,
                               required=expected, found=found,
                               reason="" if ok else "%s=%r 与预期 %r 不符" % (attr, found, expected))
    return HardRule("target_state:%s.%s" % (target_key, attr),
                    "目标 %s 的 %s 满足预期" % (target_key, attr), _check)


def rule_actor_free(actor_key: str = "player") -> HardRule:
    """行动者未被束缚 / 失能。"""
    def _check(world, actor, target):
        desc = "行动者未被束缚或失能"
        bound = world.get("condition:%s:bound" % actor_key)
        incap = world.get("condition:%s:incapacitated" % actor_key)
        if bound is True or incap is True:
            return FactCheckResult("actor_free", "missing", desc,
                                   required=False, found={"bound": bound, "incapacitated": incap},
                                   reason="行动者被束缚/失能，无法执行该动作")
        return FactCheckResult("actor_free", "satisfied", desc, required=False,
                               found={"bound": bound, "incapacitated": incap})
    return HardRule("actor_free", "行动者未被束缚或失能", _check)


def rule_distance(actor_key: str, target_key: str, max_dist: float) -> HardRule:
    """距离约束（如「够得着」）。距离事实未知 → unknown（不猜）。"""
    def _check(world, actor, target):
        desc = "%s 与 %s 距离 ≤ %s" % (actor_key, target_key, max_dist)
        d = world.get("location:distance:%s:%s" % (actor_key, target_key))
        if d is None:
            return FactCheckResult("distance:%s:%s" % (actor_key, target_key), "unknown",
                                   desc, required=max_dist, found=None, reason="距离未知")
        ok = float(d) <= max_dist
        return FactCheckResult("distance:%s:%s" % (actor_key, target_key),
                               "satisfied" if ok else "missing", desc,
                               required=max_dist, found=d,
                               reason="" if ok else "实际距离 %s 超出 %s" % (d, max_dist))
    return HardRule("distance:%s:%s" % (actor_key, target_key),
                    "%s 与 %s 距离 ≤ %s" % (actor_key, target_key, max_dist), _check)


def rule_fact(key: str, expected: Any, description: Optional[str] = None) -> HardRule:
    """通用事实断言：world 里某键必须满足预期（equal 或 in set）。"""
    def _check(world, actor, target):
        desc = description or "事实 %s 满足预期 %r" % (key, expected)
        if not world.has(key):
            return FactCheckResult("fact:%s" % key, "unknown", desc,
                                   required=expected, found=None, reason="事实 %s 未知" % key)
        found = world.get(key)
        ok = (found == expected) if not isinstance(expected, set) else (found in expected)
        return FactCheckResult("fact:%s" % key, "satisfied" if ok else "missing",
                               desc, required=expected, found=found,
                               reason="" if ok else "%s=%r 与预期 %r 不符" % (key, found, expected))
    return HardRule("fact:%s" % key, description or ("事实 %s 满足预期" % key), _check)


def check_rules(rules, world, actor=None, target=None) -> FactCheckReport:
    """批量执行一组 HardRule，返回汇总报告（纯函数）。"""
    report = FactCheckReport()
    for r in rules:
        report.add(r.run(world, actor, target))
    return report
