"""Canonical Outcome 构建（任务书 §9）与 Fail Forward 引擎。

三层职责：
  1. build_outcome(): 把 resolutions 折叠成**一条**权威结果（主意图 + 分意图档位），
     产出 state_changes（本架构中状态变化的唯一权威来源）与 narration contract。
  2. fail_forward(): 失败前进表 —— (意图 × 档位带) → costs / complications / opportunities。
     语义模板，不是测试句白名单；对象名等由 ctx 填充。
  3. degree→delta 映射：方向由意图决定（信任向 / 敌意向），量级由档位决定；
     失败档位产生**小幅反向**（虚张声势被看穿 → 怀疑不升反微降），复杂后果
     一律走 costs/complications/opportunities，不硬塞进数值。

状态写权限（§10）：本模块只**构造** StateChange 列表，真正写入由 pipeline 走
既有 Validate/Commit（经 capability 过滤：不可写信号会被拦下并留 reason）。
"""
from typing import Any, Dict, List, Optional

from .schemas import (
    ActionResolution,
    CanonicalOutcome,
    Degree,
    NarrationContract,
    StateChange,
    TurnInterpretation,
)

# 意图 → (状态信号, 目标路径, 方向)。
# 方向 -1 = 信任向（成功则 doubt 降）；+1 = 敌意向（成功则 doubt 升）。
# 只映射**当前 capability 可写**的信号（doubt_shift, A 级）。其余信号的影响
# 走 costs/complications/opportunities 的语义通道，不假装可写。
_INTENT_STATE_MAP: Dict[str, Dict[str, Any]] = {
    "information_handover": {"signal": "doubt_shift", "target": "relationship.doubt", "dir": -1},
    "evidence_handover":    {"signal": "doubt_shift", "target": "relationship.doubt", "dir": -1},
    "apology":              {"signal": "doubt_shift", "target": "relationship.doubt", "dir": -1},
    "cooperation":          {"signal": "doubt_shift", "target": "relationship.doubt", "dir": -1},
    "threat":               {"signal": "doubt_shift", "target": "relationship.doubt", "dir": +1},
    "violence":             {"signal": "doubt_shift", "target": "relationship.doubt", "dir": +1},
    "hostility":            {"signal": "doubt_shift", "target": "relationship.doubt", "dir": +1},
    "challenge":            {"signal": "doubt_shift", "target": "relationship.doubt", "dir": +1},
}

# 档位 → 量级。失败系取小负值（= 反向小幅），见模块 docstring。
_DEGREE_MAGNITUDE: Dict[Degree, float] = {
    Degree.EXCEPTIONAL_SUCCESS: 4.0,
    Degree.STRONG_SUCCESS: 3.0,
    Degree.SUCCESS: 2.2,
    Degree.PARTIAL_SUCCESS: 1.0,
    Degree.FAILURE: -0.5,
    Degree.CRITICAL_FAILURE: -1.4,
}

# ----------------------------------------------------------------------------
# Fail Forward 表：意图 × 档位带 → 语义后果。
# 带：crit（≤FAILURE），zero（PARTIAL），pos（≥SUCCESS）。
# 模板变量：{objects}（物件串）、{target}（NPC 名）。
# ----------------------------------------------------------------------------
_FAIL_FORWARD: Dict[str, Dict[str, Dict[str, List[str]]]] = {
    "evidence_handover": {
        "crit": {
            "costs": ["{target} 当场要求验货，你拿不出来"],
            "complications": ["你出示的物件被识破是假的或根本不存在，{target} 的怀疑坐实"],
            "opportunities": ["摊牌之后反而不用再伪装，可以换一条路取信"],
        },
        "zero": {
            "costs": [],
            "complications": ["{target} 收下东西但不当场验证，将信将疑"],
            "opportunities": ["她愿意保留这物件到查证之前——一个正在运转的信任凭证"],
        },
        "pos": {
            "costs": [],
            "complications": [],
            "opportunities": ["物件本身成了新的谈资：{target} 愿意就它的来历多聊两句"],
        },
    },
    "information_handover": {
        "crit": {
            "costs": ["{target} 认定你在编故事"],
            "complications": ["你给的信息与她已知的事实冲突，她当场指出矛盾"],
            "opportunities": ["既然已经说破，不如干脆坦白真正的来意"],
        },
        "zero": {
            "costs": [],
            "complications": ["信息被记下但存疑：{target} 说要亲自去核实"],
            "opportunities": ["如果信息属实，核实之日就是信任转折点"],
        },
        "pos": {
            "costs": [],
            "complications": [],
            "opportunities": ["具体、可验证的细节让{target}愿意沿着这条线索查下去"],
        },
    },
    "threat": {
        "crit": {
            "costs": ["{target} 完全不吃这一套，敌意反而加深"],
            "complications": ["你的虚张声势被看穿，主动权落到她手里"],
            "opportunities": ["被逼到墙角，反而可以摊开真正的底牌"],
        },
        "zero": {
            "costs": ["气氛僵住，谈话余地变窄"],
            "complications": ["{target} 没有退让，也没有立刻翻脸——她在等你下一步"],
            "opportunities": ["僵局里的沉默恰好是给让步留的台阶"],
        },
        "pos": {
            "costs": ["恐惧留下了痕：即使她配合，敌意也在累积"],
            "complications": [],
            "opportunities": ["威慑暂时有效，争取到说话的时间窗口"],
        },
    },
    "violence": {
        "crit": {
            "costs": ["被{target}反制，你吃了亏"],
            "complications": ["动手失败后局面彻底失控，围观者与你为敌"],
            "opportunities": ["彻底撕破脸之后，反而见到了她真正的底牌"],
        },
        "zero": {
            "costs": ["动手里谁也没占到大便宜"],
            "complications": ["扭打引来了注意，留给你们的时间不多了"],
            "opportunities": ["势均力敌的对抗让她重新掂量你的斤两"],
        },
        "pos": {
            "costs": ["武力得手，但关系与回旋余地一起赔了进去"],
            "complications": ["打斗留下了动静与痕迹"],
            "opportunities": ["她暂时被制住，你能多做一件事（搜身/逼问/脱身）"],
        },
    },
    "cooperation": {
        "zero": {
            "complications": ["好意被客气地挡了回去"],
            "opportunities": ["她记下了你的姿态，下次开口会容易一点"],
        },
    },
    "apology": {
        "zero": {
            "complications": ["道歉被收到，但没有换来实质让步"],
            "opportunities": ["情绪降温给了双方台阶"],
        },
    },
    "hostility": {
        "pos": {
            "costs": ["敌意是相互的：她的戒备跟着升级"],
        },
    },
    "challenge": {
        "pos": {
            "complications": ["被将军的她必须做出回应，无论接不接"],
            "opportunities": ["她若接下挑战，就进入了你的节奏"],
        },
        "zero": {
            "complications": ["挑衅被轻轻带过，像打在棉花上"],
        },
    },
}


def _band(degree: Degree) -> str:
    if degree <= Degree.FAILURE:
        return "crit"
    if degree == Degree.PARTIAL_SUCCESS:
        return "zero"
    return "pos"


def _fmt_list(templates: List[str], objects: List[str], target: str) -> List[str]:
    objs = "、".join(objects[:2]) if objects else "东西"
    return [t.format(objects=objs, target=target) for t in templates]


def fail_forward(intent_type: str, degree: Degree,
                 objects: Optional[List[str]] = None,
                 target: str = "对方") -> Dict[str, List[str]]:
    """失败前进：按（意图 × 档位带）取语义后果。无表项的意图/带返回空。"""
    table = _FAIL_FORWARD.get(intent_type) or {}
    entry = table.get(_band(degree)) or {}
    return {
        "costs": _fmt_list(entry.get("costs") or [], objects or [], target),
        "complications": _fmt_list(entry.get("complications") or [], objects or [], target),
        "opportunities": _fmt_list(entry.get("opportunities") or [], objects or [], target),
    }


# ----------------------------------------------------------------------------
# 主意图选择：多意图时挑"结算权重"最高的一条作为 primary
# ----------------------------------------------------------------------------
_PRIMARY_WEIGHT = {
    "violence": 9, "threat": 7,
    "evidence_handover": 8, "information_handover": 7,
    "false_claim_reflex": 0,
    "cooperation": 5, "apology": 4, "hostility": 3, "challenge": 3,
    "question": 1, "neutral": 0, "other": 0,
}


def _primary_index(interp: TurnInterpretation) -> int:
    if not interp.intents:
        return -1
    best, best_w = 0, -1
    for i, it in enumerate(interp.intents):
        w = _PRIMARY_WEIGHT.get(it.type, 0) * (0.6 + 0.4 * it.confidence)
        if w > best_w:
            best, best_w = i, w
    return best


def build_outcome(turn_id: str, interp: TurnInterpretation,
                  resolutions: List[ActionResolution],
                  target_name: str = "对方") -> CanonicalOutcome:
    """把多意图结算折叠成唯一权威 Outcome（含 state_changes 与 narration contract）。"""
    degrees: Dict[str, str] = {}
    for res in resolutions:
        idx = res.intent_ref
        itype = interp.intents[idx].type if 0 <= idx < len(interp.intents) else "other"
        degrees[itype] = res.degree.label

    pi = _primary_index(interp)
    primary = interp.intents[pi] if pi >= 0 else None
    primary_res = resolutions[pi] if 0 <= pi < len(resolutions) else None
    ptype = primary.type if primary else "neutral"
    pdeg = primary_res.degree if primary_res else Degree.FAILURE

    # ---- state_changes：主意图裁决产出（其余意图的影响走语义通道）----
    changes: List[StateChange] = []
    mapping = _INTENT_STATE_MAP.get(ptype)
    if mapping:
        magnitude = _DEGREE_MAGNITUDE.get(pdeg, 0.0)
        if magnitude:
            delta = round(mapping["dir"] * magnitude, 3)
            reason = _state_reason(ptype, pdeg, primary, primary_res)
            changes.append(StateChange(
                source_signal=mapping["signal"], target=mapping["target"],
                delta=delta, reason=reason,
                resolved_by="resolver:%s" % ptype, degree=pdeg.label))

    # ---- fail forward ----
    ff = fail_forward(ptype, pdeg, objects=(primary.objects if primary else None),
                      target=target_name)
    facts_created = _facts_created(interp, ptype, pdeg)

    result_line = _result_line(ptype, pdeg, primary, target_name)
    contract = _narration_contract(ptype, pdeg, changes, ff, target_name)

    return CanonicalOutcome(
        turn_id=turn_id, primary_intent=ptype, result=result_line, degree=pdeg,
        degrees=degrees, facts_created=facts_created,
        state_changes=changes,
        costs=ff["costs"], complications=ff["complications"],
        opportunities=ff["opportunities"], narration_contract=contract)


def _state_reason(ptype: str, degree: Degree, intent, res) -> str:
    base = {"information_handover": "交代信息", "evidence_handover": "出示证据",
            "apology": "道歉", "cooperation": "示好合作",
            "threat": "言语威胁", "violence": "动手", "hostility": "敌意表达",
            "challenge": "挑衅"}.get(ptype, ptype)
    why = (res.rationale if res else "")
    return "%s（%s）→ 怀疑 %+0.1f | %s" % (base, degree.label,
                                           _DEGREE_MAGNITUDE.get(degree, 0.0), why)


def _facts_created(interp: TurnInterpretation, ptype: str, pdeg: Degree) -> List[str]:
    """本轮经裁决成立的新事实（供后续轮次 FactBase/叙事引用）。"""
    facts: List[str] = []
    for it in interp.intents:
        if it.type == "information_handover":
            facts.append("玩家交代了信息（%s）" % ("、".join(it.objects) if it.objects else "泛指"))
        elif it.type == "evidence_handover":
            facts.append("玩家声称交出物件（%s）" % ("、".join(it.objects) if it.objects else "未指明"))
    if pdeg >= Degree.SUCCESS and ptype == "threat":
        facts.append("玩家发出了有效威胁")
    if pdeg <= Degree.CRITICAL_FAILURE:
        facts.append("本轮行动被彻底反制")
    return facts[:6]


def _result_line(ptype: str, pdeg: Degree, intent, target: str) -> str:
    obj = "、".join((intent.objects or [])[:2]) if intent else ""
    head = {
        "evidence_handover": "出示证据" + ("（%s）" % obj if obj else ""),
        "information_handover": "交代信息",
        "threat": "发出威胁",
        "violence": "动手",
        "cooperation": "示好",
        "apology": "道歉",
        "hostility": "表达敌意",
        "challenge": "挑衅",
        "question": "提问",
        "neutral": "陈述",
        "other": "行动",
    }.get(ptype, ptype)
    tail = {
        Degree.CRITICAL_FAILURE: "被彻底反制",
        Degree.FAILURE: "没有奏效",
        Degree.PARTIAL_SUCCESS: "部分奏效",
        Degree.SUCCESS: "奏效",
        Degree.STRONG_SUCCESS: "显著奏效",
        Degree.EXCEPTIONAL_SUCCESS: "完全奏效并留下机会",
    }[pdeg]
    return "玩家%s——%s" % (head, tail)


def _narration_contract(ptype: str, pdeg: Degree, changes: List[StateChange],
                        ff: Dict[str, List[str]], target: str) -> NarrationContract:
    """Story Agent 的边界（§11）：必须体现的事实、允许的自由度、语义禁区。"""
    must = ["本轮行动的最终结果是「%s」" % pdeg.label]
    for c in changes:
        must.append("怀疑值变化 %+.1f（只体现倾向，不念数字）" % c.delta)
    must += ["%s" % x for x in (ff["complications"] or [])[:2]]

    may = ["动作细节、环境反应、NPC 的语气与微表情",
           "NPC 主动发起的一句回应（她自己的意图）"]

    must_not: List[str] = []
    if pdeg <= Degree.FAILURE:
        must_not += ["完全相信", "松了口", "交出秘密", "答应", "被打动"]
    if pdeg == Degree.PARTIAL_SUCCESS:
        must_not += ["完全相信", "和盘托出", "彻底放下戒心"]
    if pdeg >= Degree.SUCCESS and ptype in ("threat", "violence"):
        must_not += ["毫不在意", "毫不畏惧", "完全不信"]
    if pdeg >= Degree.SUCCESS and ptype in ("evidence_handover", "information_handover"):
        must_not += ["完全不信", "根本不吃这一套"]
    must_not += ["念出任何数值", "代替玩家说话或决定"]

    summary = "结果=%s；主意图=%s；代价=%d； complication=%d；机会=%d" % (
        pdeg.label, ptype, len(ff["costs"]), len(ff["complications"]), len(ff["opportunities"]))
    return NarrationContract(must_include=must, may_include=may,
                             must_not_include=must_not, state_summary=summary)
