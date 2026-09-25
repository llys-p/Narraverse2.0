"""Facts / Hard Rules：行动前提的事实验证（任务书 §6）。

设计：
  · FactBase 按 (session_id, actor_id) 隔离 —— 与 Actor State 同一隔离粒度，
    不引入新的全局状态；进程内存实现 + 显式接口（未来接物品/世界系统）。
  · FactChecker 是**语义级规则**（基于 Interpreter 给出的结构化意图与物件名），
    不是文本关键词匹配：判断"这个意图在当前事实下能不能做"，不做"这句话里有没有某词"。
  · 本轮不实现完整 RPG Rules Engine；Hard Rules 以 verdict + reason 输出，
    Resolver 消费 verdict（insufficient 降级结算 / false_claim 反噬 / denied 禁止）。

事实种类（第一版）：
  · inventory —— 行动主体持有的物件（evidence_handover 的前提）
  · world_facts —— 命名世界事实（门/井/位置是否存在、是否已开）
  · statuses —— 行动主体状态（bound / incapacitated 等）
  · claims —— 已登记的信息声明（information_handover 的可信度参考）
"""
from typing import Any, Dict, List, Optional

from .schemas import FactCheckResult

# FactBase 存储（per scope；与 laya_bridge 的桶隔离粒度一致）
_FACT_BASES: Dict[str, Dict[str, Any]] = {}

_DEFAULT_BASE: Dict[str, Any] = {"inventory": [], "world_facts": {}, "statuses": {}, "claims": []}


def _scope(session_id: str, actor_id: str) -> str:
    return "%s/%s" % (session_id or "default", actor_id or "default")


def get_fact_base(session_id: str, actor_id: str, create: bool = True) -> Dict[str, Any]:
    key = _scope(session_id, actor_id)
    base = _FACT_BASES.get(key)
    if base is None and create:
        base = {"inventory": [], "world_facts": {}, "statuses": {}, "claims": []}
        _FACT_BASES[key] = base
    return base


def set_fact_base(session_id: str, actor_id: str, base: Dict[str, Any]) -> None:
    """整包注入（测试/导演用）；正常流程走 add_* 接口。"""
    _FACT_BASES[_scope(session_id, actor_id)] = {
        "inventory": list(base.get("inventory") or []),
        "world_facts": dict(base.get("world_facts") or {}),
        "statuses": dict(base.get("statuses") or {}),
        "claims": list(base.get("claims") or []),
    }


def add_item(session_id: str, actor_id: str, item: str) -> None:
    base = get_fact_base(session_id, actor_id)
    if item not in base["inventory"]:
        base["inventory"].append(item)


def add_world_fact(session_id: str, actor_id: str, key: str, value: Any) -> None:
    get_fact_base(session_id, actor_id)["world_facts"][key] = value


def set_status(session_id: str, actor_id: str, status: str, value: bool) -> None:
    get_fact_base(session_id, actor_id)["statuses"][status] = bool(value)


def add_claim(session_id: str, actor_id: str, claim: str) -> None:
    get_fact_base(session_id, actor_id)["claims"].append(claim)


def reset_fact_bases(session_id: Optional[str] = None, actor_id: Optional[str] = None) -> None:
    """清理（/reset 联动或测试）。都传 None = 全清。"""
    if session_id is None and actor_id is None:
        _FACT_BASES.clear()
        return
    for k in list(_FACT_BASES):
        if k.startswith("%s/" % (session_id or "")):
            _FACT_BASES.pop(k, None)


def snapshot_fact_base(session_id: str, actor_id: str) -> Dict[str, Any]:
    base = _FACT_BASES.get(_scope(session_id, actor_id)) or {}
    return {k: (list(v) if isinstance(v, list) else dict(v))
            for k, v in base.items()} if base else {}


# ----------------------------------------------------------------------------
# 物件归一：Interpreter 给的 objects 是自由名词（"徽章"/"那枚徽章"），
# 与 inventory 里的登记名做**子串双向匹配**。这不是玩家输入的关键词匹配——
# 这是"声称的物件"与"登记的物件"之间的对账，语义输入已经由 Interpreter 归一。
# ----------------------------------------------------------------------------
def _match_object(obj: str, inventory: List[str]) -> Optional[str]:
    o = (obj or "").strip()
    if not o:
        return None
    for item in inventory:
        if o in item or item in o:
            return item
    return None


def check_facts(session_id: str, actor_id: str, intents: list) -> List[FactCheckResult]:
    """对每条意图做前提验证。输出与 intents 等长、按 index 对齐。"""
    base = get_fact_base(session_id, actor_id)
    results = []
    for idx, intent in enumerate(intents):
        results.append(_check_one(idx, intent, base))
    return results


def _check_one(idx: int, intent, base: Dict[str, Any]) -> FactCheckResult:
    t = intent.type
    inv = base.get("inventory") or []
    world = base.get("world_facts") or {}
    statuses = base.get("statuses") or {}

    # 束缚/失能：任何主动行动都被硬规则禁止
    if statuses.get("bound") or statuses.get("incapacitated"):
        if t in ("violence", "threat", "evidence_handover",
                 "information_handover", "cooperation", "challenge"):
            return FactCheckResult(
                intent_ref=idx, verdict="denied",
                reasons=["行动主体被束缚/失能，硬规则禁止主动行动"],
                facts_used={"statuses": dict(statuses)})

    if t == "evidence_handover":
        # 每个声称交出的物件都必须真的持有
        missing, held = [], []
        for obj in (intent.objects or []):
            m = _match_object(obj, inv)
            (held if m else missing).append(m or obj)
        if not intent.objects:
            # 没给物件名：无法对账 → 降级（不做"默认成功"的 fail-open）
            return FactCheckResult(
                intent_ref=idx, verdict="insufficient",
                reasons=["evidence_handover 未指明物件，无法核验持有"],
                facts_used={"inventory": list(inv)})
        if missing:
            return FactCheckResult(
                intent_ref=idx, verdict="false_claim",
                reasons=["声称交出未持有的物件: %s" % "、".join(missing)],
                facts_used={"inventory": list(inv), "missing": missing})
        return FactCheckResult(
            intent_ref=idx, verdict="ok",
            reasons=["持有物件: %s" % "、".join(held)],
            facts_used={"inventory": list(inv), "held": held})

    if t == "information_handover":
        # 知识不设前提（无法验证玩家"知不知道"），但登记 claim 供后续对账
        return FactCheckResult(
            intent_ref=idx, verdict="ok",
            reasons=["信息交代不需要实物前提；已登记声明供后续对账"],
            facts_used={"claims": len(base.get("claims") or [])})

    if t == "violence":
        # 暴力需要武器/徒手环境前提：显式登记"缴械"时降级
        if statuses.get("disarmed"):
            return FactCheckResult(
                intent_ref=idx, verdict="insufficient",
                reasons=["行动主体已缴械，暴力行动降级结算"],
                facts_used={"statuses": dict(statuses)})
        return FactCheckResult(intent_ref=idx, verdict="ok",
                               reasons=[], facts_used={})

    if t in ("threat", "hostility", "cooperation", "apology", "question",
             "challenge", "neutral", "other"):
        # 这些意图没有硬前提；环境修正交给 Resolver 的 environment 通道
        return FactCheckResult(intent_ref=idx, verdict="ok",
                               reasons=[], facts_used={})

    return FactCheckResult(intent_ref=idx, verdict="ok",
                           reasons=["未知意图类型按无前提处理"], facts_used={})
