"""Server-authored scene rules. No natural-language matching and no model-written numbers."""
from copy import deepcopy
from dataclasses import dataclass

from .contracts import (ActionResolution, CanonicalOutcome, Degree, FactCheckResult,
                        ResolutionContext, StateChange)

WORLD = "ic_world"
RULESET = "interaction-a-rules-v1"
DEGREES = tuple(Degree)


@dataclass(frozen=True)
class ActionRule:
    skill: str
    difficulty: float
    energy: float = 0
    contested: bool = False
    relationship: bool = False


RULES = {
    "communicate": ActionRule("", 0),
    "persuade": ActionRule("persuasion", 4, contested=True, relationship=True),
    "transfer": ActionRule("", 0),
    "unlock": ActionRule("", 0),
    "force": ActionRule("strength", 6, energy=2),
    "attack": ActionRule("combat", 5, energy=2, contested=True),
    "inspect": ActionRule("perception", 3, energy=1),
    "assist": ActionRule("craft", 3, energy=1),
}


def get_path(state, path):
    value = state
    for key in path.split("."):
        value = value[key]
    return value


def set_path(state, path, value):
    parts = path.split(".")
    obj = state
    for key in parts[:-1]:
        obj = obj[key]
    obj[parts[-1]] = deepcopy(value)


def check_facts(action, target_id, states):
    """Possession, location and prerequisites are read solely from committed scene data."""
    source = states[action.actor_id]["interaction"]
    world = states[WORLD]["interaction"]
    objects = world["objects"]
    target = states.get(target_id, {}).get("interaction") or objects.get(target_id)
    reasons, evidence = [], []
    rule = RULES[action.operation]
    if action.mode != "attempt":
        reasons.append("not_an_attempt")
    if source.get("incapacitated"):
        reasons.append("actor_incapacitated")
    if target is None or target_id == WORLD:
        reasons.append("target_unresolved")
    elif target.get("location") != source["location"]:
        reasons.append("target_out_of_reach")
    if source["energy"] < rule.energy:
        reasons.append("insufficient_energy")
    if action.operation in {"transfer", "unlock", "force", "attack", "assist"} and source.get("restrained"):
        reasons.append("actor_restrained")
    if action.operation in {"communicate", "persuade", "assist"}:
        if target_id not in states or target_id == WORLD or target_id == action.actor_id:
            reasons.append("requires_other_actor")
        elif target.get("incapacitated"):
            reasons.append("recipient_unavailable")
    if action.operation == "transfer":
        item = objects.get(action.object_id)
        if len(action.target_ids) != 1 or target_id not in states or target_id == WORLD:
            reasons.append("transfer_requires_one_actor")
        if not item or item.get("owner") != action.actor_id:
            reasons.append("item_not_owned")
        elif item.get("portable") is not True:
            reasons.append("item_not_portable")
        else:
            evidence.append("possession:" + action.object_id)
    if action.operation == "unlock":
        key = objects.get(action.tool_id)
        if not key or key.get("owner") != action.actor_id:
            reasons.append("key_not_owned")
        if not target or target.get("kind") != "door":
            reasons.append("target_not_door")
        elif target.get("open"):
            reasons.append("already_open")
        elif target.get("locked") and (not key or key.get("opens") != target_id):
            reasons.append("key_mismatch")
    if action.operation == "force" and (not target or target.get("kind") != "door"):
        reasons.append("target_not_door")
    if action.operation == "force" and target and target.get("open"):
        reasons.append("already_open")
    if action.operation == "attack":
        if not target or "health" not in target or target_id == action.actor_id:
            reasons.append("target_not_attackable")
        if action.tool_id:
            tool = objects.get(action.tool_id)
            if not tool or tool.get("owner") != action.actor_id:
                reasons.append("tool_not_owned")
    if action.operation == "inspect" and target and target.get("verified_clue"):
        evidence.append("inspectable_clue:" + target_id)
    return FactCheckResult(action.id, not reasons, tuple(reasons), tuple(evidence))


def degree_for(margin):
    # Fixed, versioned balance policy. Calibration belongs to later gameplay evaluation.
    for threshold, degree in ((-6, Degree.CRITICAL_FAILURE), (-2, Degree.FAILURE),
                              (1, Degree.PARTIAL_SUCCESS), (4, Degree.SUCCESS),
                              (7, Degree.STRONG_SUCCESS)):
        if margin < threshold:
            return degree
    return Degree.EXCEPTIONAL_SUCCESS


def resolution_context(action, target_id, states, evidence):
    actor = states[action.actor_id]["interaction"]
    target_state = states.get(target_id, {})
    target = target_state.get("interaction") or states[WORLD]["interaction"]["objects"].get(target_id, {})
    rule = RULES[action.operation]
    if not rule.skill:
        return ResolutionContext(action.id, target_id, {}, None, "prerequisites_sufficient")
    skill = actor["stats"].get(rule.skill, 0)
    difficulty = target.get("difficulty", {}).get(action.operation, rule.difficulty)
    opposition = target.get("stats", {}).get("resolve" if rule.relationship else "defense", 0) if rule.contested else 0
    relation = target_state.get("relationship", {})
    relationship = max(-2, min(2, (relation.get("trust", 50) - 50 - relation.get("doubt", 0) / 2) / 25)) if rule.relationship and target.get("relationship_to") == action.actor_id else 0
    tendency = evidence.get(target_id).tendency if rule.relationship and target_id in evidence else 0
    environment = states[WORLD]["interaction"]["environment"].get(action.operation, 0)
    equipment = 0
    if action.tool_id:
        tool = states[WORLD]["interaction"]["objects"].get(action.tool_id, {})
        if tool.get("owner") == action.actor_id:
            equipment = tool.get("bonuses", {}).get(rule.skill, 0)
    support = actor.get("support", 0)
    verified = any(f.get("kind") == "observed_fact" and f.get("observer") == action.actor_id
                   and f.get("target") == action.object_id
                   for f in states[WORLD]["interaction"]["facts"]) if action.object_id else False
    evidence_bonus = 1 if rule.relationship and verified else 0
    factors = {"skill": skill, "equipment": equipment, "support": support,
               "environment": environment, "relationship": relationship,
               "laya_tendency": tendency, "verified_evidence": evidence_bonus,
               "difficulty": -difficulty, "opposition": -opposition}
    return ResolutionContext(action.id, target_id, factors, round(sum(factors.values()), 4), RULESET)


def resolve_one(action, target_id, states, evidence, blocked=False):
    check = check_facts(action, target_id, states)
    if blocked:
        check = FactCheckResult(action.id, False, check.reasons + ("dependency_not_satisfied",))
    context = resolution_context(action, target_id, states, evidence)
    if not check.allowed:
        return ActionResolution(action.id, target_id, Degree.FAILURE, "未执行：" + ", ".join(check.reasons),
                                context, check, opportunities=("先满足动作前提，再重新尝试。",))
    degree = Degree.SUCCESS if context.margin is None else degree_for(context.margin)
    full = DEGREES.index(degree) >= DEGREES.index(Degree.SUCCESS)
    partial = degree == Degree.PARTIAL_SUCCESS
    changes, facts, costs, complications, opportunities = [], [], [], [], []
    objects = states[WORLD]["interaction"]["objects"]
    target = states.get(target_id, {}).get("interaction") or objects.get(target_id, {})

    def change(entity, path, value):
        changes.append(StateChange(entity, path, get_path(states[entity], path), value, "rule:" + action.id))

    rule = RULES[action.operation]
    if rule.energy:
        energy = states[action.actor_id]["interaction"]["energy"]
        change(action.actor_id, "interaction.energy", energy - rule.energy)
        costs.append("%s 消耗 %s 精力" % (action.actor_id, rule.energy))
    if rule.skill and states[action.actor_id]["interaction"].get("support", 0):
        change(action.actor_id, "interaction.support", 0)
    achieved = "行动未达成目标"
    if action.operation == "communicate":
        achieved = "信息已传达；内容真实性及对方是否接受均未确认"
        facts.append({"kind": "communicated_claim", "speaker": action.actor_id,
                      "recipient": target_id, "content": action.content, "truth": "unverified"})
    elif action.operation == "transfer":
        change(WORLD, "interaction.objects.%s.owner" % action.object_id, target_id)
        facts.append({"kind": "ownership", "object": action.object_id, "owner": target_id})
        achieved = "%s 已交给 %s" % (action.object_id, target_id)
    elif action.operation in {"unlock", "force"}:
        if full:
            change(WORLD, "interaction.objects.%s.open" % target_id, True)
            change(WORLD, "interaction.objects.%s.locked" % target_id, False)
            achieved = "门已打开"
        elif partial:
            change(WORLD, "interaction.objects.%s.difficulty.force" % target_id,
                   max(0, target["difficulty"]["force"] - 1))
            achieved = "门框松动，但门仍未打开"
        else:
            complications.append("尝试发出声响，现场噪声增加。")
            change(WORLD, "interaction.noise", states[WORLD]["interaction"]["noise"] + 1)
            opportunities.append("可以寻找匹配的钥匙或请求协助。")
    elif action.operation == "attack":
        damage = (1 if partial else 2 + max(0, DEGREES.index(degree) - 3)) if (partial or full) else 0
        if damage:
            entity, path = (target_id, "interaction.health") if target_id in states else (WORLD, "interaction.objects.%s.health" % target_id)
            health = max(0, target["health"] - damage)
            change(entity, path, health)
            if target_id in states and health == 0:
                change(entity, "interaction.incapacitated", True)
            achieved = "造成 %s 点伤害" % damage
        else:
            opportunities.append("可以调整位置、求助或停止攻击。")
        complications.append("这次攻击已成为可追溯的敌对事件。")
        facts.append({"kind": "attack_attempt", "actor": action.actor_id, "target": target_id, "damage": damage})
    elif action.operation == "persuade":
        # Openness is not agreement. No transfer, allegiance or revelation is implied.
        value = "receptive" if full else "considering" if partial else "declined"
        change(target_id, "interaction.openness", value)
        achieved = {"receptive": "对方愿意继续商谈，尚未承诺具体请求", "considering": "对方保留意见，愿意听进一步依据",
                    "declined": "对方拒绝这次说服"}[value]
        if not full:
            opportunities.append("可以提供可核验的证据，再提出请求。")
    elif action.operation == "inspect":
        clue = target.get("verified_clue")
        if full and clue:
            facts.append({"kind": "observed_fact", "observer": action.actor_id,
                          "target": target_id, "content": clue})
            achieved = "发现已登记线索：" + clue
        elif full:
            achieved = "检查完成，没有发现额外的已登记线索"
        elif partial:
            achieved = "检查尚未完成，无法确认额外信息"
            opportunities.append("改善观察条件后可继续检查。")
    elif action.operation == "assist":
        if full or partial:
            change(target_id, "interaction.support", 2 if full else 1)
            achieved = "对方下一次技能行动得到一次性协助"
    return ActionResolution(action.id, target_id, degree, achieved, context, check,
                            tuple(changes), tuple(facts), tuple(costs), tuple(complications), tuple(opportunities))


def resolve_turn(turn, interpretation, scene, evidence):
    """Sequential local simulation; no store write. Later actions see earlier rule effects."""
    states = deepcopy(scene.states)
    by_target = {e.actor_id: e for e in evidence}
    resolutions, completed = [], {}
    for action in interpretation.actions:
        current = []
        for target in action.target_ids or (None,):
            r = resolve_one(action, target, states, by_target,
                            blocked=bool(action.depends_on and not completed.get(action.depends_on)))
            for change in r.changes:
                set_path(states[change.entity_id], change.path, change.after)
            states[WORLD]["interaction"]["facts"].extend(deepcopy(r.facts))
            current.append(r)
        resolutions.extend(current)
        completed[action.id] = all(DEGREES.index(r.degree) >= 3 for r in current)
    # Aggregate is summary only; individual resolutions remain the exact authority.
    degrees = [r.degree for r in resolutions]
    degree = degrees[0] if len(set(degrees)) == 1 else Degree.PARTIAL_SUCCESS
    return CanonicalOutcome(turn.event_id, "resolved", degree, tuple(resolutions),
        tuple(f for r in resolutions for f in r.facts), tuple(c for r in resolutions for c in r.changes),
        tuple(c for r in resolutions for c in r.costs),
        tuple(c for r in resolutions for c in r.complications),
        tuple(c for r in resolutions for c in r.opportunities))
