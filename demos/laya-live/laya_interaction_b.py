"""Candidate B: free semantic input, explicit facts, deterministic resolution, one commit."""
from __future__ import annotations

import copy
import json
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import laya_bridge as B
from laya_facts import FactCheckResult, WorldState, check_rules, rule_actor_free, rule_fact, rule_owned_item
from laya_resolver import LayaEvidence, ResolutionContext, resolve
from laya_turn_interpreter import interpret_semantic

WORLD_ID = "b_runtime_world"
ACTORS = ("player", "lia", "oren")
NAMES = {"player": "玩家", "lia": "莉亚", "oren": "奥伦",
         "cellar_door": "地窖门", "cellar_key": "地窖钥匙", "badge": "徽章", "apple": "苹果",
         "knife": "小刀", "old_well": "旧井", "tavern": "酒馆"}
ALIASES = {**{key: key for key in NAMES}, **{value: key for key, value in NAMES.items()},
           "Lia": "lia", "Oren": "oren", "门": "cellar_door", "钥匙": "cellar_key"}
GRADES_OK = {"success", "strong_success", "exceptional_success"}


class CoreError(Exception):
    def __init__(self, code, message, http=422):
        self.code, self.http = code, http
        super().__init__(message)


def _actor(name):
    state = B._blank_actor_state(B.CFG["actor"])
    state["name"] = NAMES[name]
    state["name_en"] = name.title()
    state["interaction"] = {"stats": {"strength": .55, "combat": .55,
        "sincerity": .55, "credibility": .55, "eloquence": .55, "perception": .55,
        "presence": .55, "willpower": .55}, "stamina": 5}
    if name == "player":
        state["relationship"] = {}
    elif name == "oren":
        state["relationship"].update(trust=45, doubt=35)
        state["traits"] = {}
        state["goals"] = {}
    return state


def _world():
    return {"name": "酒馆运行场景", "facts": {
        "entity:lia": True, "entity:oren": True, "entity:player": True,
        "entity:cellar_door": True, "entity:apple": True, "entity:cellar_key": True,
        "entity:badge": True, "entity:knife": True, "entity:old_well": True, "entity:tavern": True,
        "entity:cellar_door:open": False,
        "entity:apple:cut": False,
        "scene:alert": 0,
        "inventory:player:badge": True, "inventory:lia:badge": False,
        "inventory:player:knife": True,
        "inventory:player:cellar_key": False,
        "item:cellar_key:opens": "cellar_door",
        "location:cellar_key": "old_well",
        "location:badge": "carried:player", "location:knife": "carried:player",
        "location:apple": "tavern", "location:cellar_door": "tavern",
        "location:player": "tavern", "location:lia": "tavern", "location:oren": "tavern",
        "location:tavern": "tavern", "location:old_well": "old_well",
        "health:player": 10, "health:lia": 10, "health:oren": 10,
        "condition:player:bound": False, "condition:player:incapacitated": False,
        "condition:lia:bound": False, "condition:lia:incapacitated": False,
        "condition:oren:bound": False, "condition:oren:incapacitated": False,
    }, "claims": [], "history": [], "turn": 0,
        "environment": {"visibility": 0.0}}


def _copy(obj):
    return copy.deepcopy(obj)


def _where(facts, entity):
    place = facts.get("location:%s" % entity)
    if isinstance(place, str) and place.startswith("carried:"):
        return facts.get("location:%s" % place.split(":", 1)[1])
    return place


def _narrate(outcome):
    lines = []
    for row in outcome["resolutions"]:
        subject = NAMES.get(row["target_id"], row["target_id"])
        lines.append("%s：%s。%s" % (subject, row["resolution"]["result"], row["result_text"]))
    lines.extend(outcome["costs"])
    lines.extend(outcome["complications"])
    lines.extend(outcome["opportunities"])
    return "\n".join(lines)


@dataclass
class Pending:
    analysis_id: str
    session_id: str
    event_id: str
    actor_id: str
    message: str
    expected_versions: dict
    interpretation: dict
    evidence: dict
    rules_fingerprint: str | None
    outcome: dict
    states: dict
    expires_at: float


class InteractionB:
    def __init__(self):
        self.pending = {}
        self.inflight = set()

    def _snapshot(self, sid):
        states, versions = {}, {}
        for entity in (*ACTORS, WORLD_ID):
            template = _world() if entity == WORLD_ID else _actor(entity)
            state = _copy(template)
            state.update(_copy(B._ACTOR_STATE.get((sid, entity), {})))
            states[entity] = state
            versions[entity] = B.PROTOCOL.state_version((sid, entity))
        return states, versions

    def state(self, sid):
        if not isinstance(sid, str) or not sid:
            raise CoreError("BAD_SESSION", "session_id 必填")
        with B.PROTOCOL.lock:
            states, versions = self._snapshot(sid)
        return {"session_id": sid, "states": states, "versions": versions}

    def _event(self, sid, event_id):
        return B.PROTOCOL._events.get((sid, WORLD_ID), {}).get(event_id, {})

    def _interpret(self, message, world, actor_id):
        context = {"targets": ["%s=%s" % (k, v) for k, v in NAMES.items()],
                   "history": world["history"][-8:], "facts": world["facts"],
                   "actor_id": actor_id}
        interpreted = interpret_semantic(message, context)
        if interpreted.status != "ok":
            raise CoreError("INTERPRETATION_FAILED", interpreted.invalid_reason or "无法理解", 502)
        if not interpreted.intents:
            raise CoreError("NEEDS_CLARIFICATION", "没有可结算的行动", 409)
        return interpreted

    def _laya(self, sid, actor_id, states, target_messages):
        evidence, fingerprint = {}, None
        if not B.ENGINE.ready:
            raise CoreError("LAYA_UNAVAILABLE", "Laya 未就绪；本候选不把 fallback 当成真实证据", 503)
        if actor_id != "player":
            return evidence, fingerprint
        model = B.PROTOCOL._effective_model()
        B.PROTOCOL._assert_engine(model)
        fingerprint = B.PROTOCOL.rules_fingerprint(model)
        profile, profile_check = B.load_capability_profile(model)
        if not profile_check.get("fresh") or not profile_check.get("matched"):
            raise CoreError("PROFILE_UNAVAILABLE", "Laya 能力档案不匹配，不能用于本轮结算", 409)
        for target, utterance in target_messages.items():
            if target == actor_id or target not in ACTORS or target == "player":
                continue
            actor = _copy(B.CFG["actor"])
            actor.update({"name": NAMES[target], "name_en": target.title()})
            if target == "oren":
                actor.update(identity="酒馆旅人", identity_en="a traveler in the tavern",
                             traits={}, goals={}, personality={})
            core = B.analyze_core({"session_id": sid, "actor_id": target,
                "actor": actor, "player_input": utterance,
                "history": states[WORLD_ID]["history"][-8:]},
                frozen_state=states[target], legacy_adjudication=False)
            if core.get("engine") != B.ENGINE_MODE_LAYA:
                raise CoreError("LAYA_INFERENCE_FAILED", "本轮 Laya 实际推理失败", 503)
            values = core.get("signal_values", {})
            active = {r["signal"]: values.get(r["signal"])
                      for r in core.get("signal_table", [])
                      if r.get("status") == "active" and r.get("signal") in values}
            evidence[target] = {"signals": active, "all_signals": values,
                "proposal": core.get("state_proposal") or {}, "source": "laya",
                "checkpoint": model}
        return evidence, fingerprint

    def _calculate(self, sid, actor_id, message, interpretation, evidence, original):
        """Pure on a copy of server state; facts are checked again after each action."""
        states = _copy(original)
        world = states[WORLD_ID]
        resolutions, facts_created, costs, complications, opportunities, changes = [], [], [], [], [], []
        for index, raw in enumerate(interpretation["intents"]):
            operation = raw.get("operation", "speak")
            object_id = ALIASES.get(raw.get("object_id"), raw.get("object_id"))
            default_listener = "lia" if actor_id == "player" else "player"
            targets = raw.get("targets") or ([default_listener] if operation in {"speak", "persuade"} else [])
            if not targets:
                raise CoreError("TARGET_REQUIRED", "物理动作必须指定目标", 409)
            for name in targets:
                target = ALIASES.get(name)
                if not target:
                    raise CoreError("TARGET_UNKNOWN", "目标不属于当前场景：%s" % name, 409)
                state = WorldState(sid, WORLD_ID, _copy(world["facts"]))
                checks = [rule_actor_free(actor_id), rule_fact("entity:%s" % target, True)]
                if operation in {"give", "attack", "unlock", "inspect", "take", "use", "speak", "persuade"}:
                    actor_place = _where(world["facts"], actor_id)
                    target_place = _where(world["facts"], target)
                    if not actor_place or target_place != actor_place:
                        checks.append(rule_fact("location:%s" % target, actor_place))
                if operation == "give":
                    if target not in ACTORS or not object_id:
                        raise CoreError("GIVE_TARGET", "交付必须有物品与接收角色", 409)
                    checks.append(rule_owned_item(object_id, actor_id))
                elif operation == "unlock":
                    if target != "cellar_door" or not object_id:
                        raise CoreError("UNLOCK_TARGET", "开锁须指定门和钥匙", 409)
                    checks.extend([rule_owned_item(object_id, actor_id),
                        rule_fact("item:%s:opens" % object_id, target),
                        rule_fact("entity:%s:open" % target, False)])
                elif operation == "attack":
                    if target not in ACTORS or target == actor_id:
                        raise CoreError("ATTACK_TARGET", "当前场景只有角色目标可受攻击", 409)
                elif operation in ("speak", "persuade") and target not in ACTORS:
                    raise CoreError("SPEECH_TARGET", "说话目标须为在场角色", 409)
                elif operation == "move" and target not in {"tavern", "old_well"}:
                    raise CoreError("MOVE_TARGET", "当前只能移动到已登记地点", 409)
                elif operation == "take":
                    if target not in {"cellar_key", "apple", "badge", "knife"}:
                        raise CoreError("TAKE_TARGET", "目标不是可拾取物品", 409)
                    if world["facts"].get("location:%s" % target, "").startswith("carried:"):
                        checks.append(rule_fact("location:%s" % target, _where(world["facts"], actor_id)))
                elif operation == "use":
                    if target != "apple" or not object_id:
                        raise CoreError("USE_TARGET", "目前支持持有工具处理苹果", 409)
                    checks.append(rule_owned_item(object_id, actor_id))
                report = check_rules(checks, state, actor=actor_id, target=target)
                if operation in {"give", "attack", "unlock", "inspect", "take", "use", "speak", "persuade"}:
                    actor_place = _where(world["facts"], actor_id)
                    target_place = _where(world["facts"], target)
                    if not actor_place or target_place != actor_place:
                        report.add(FactCheckResult("reach", "missing", "行动者与目标须在同一地点",
                                                   required=actor_place, found=target_place))
                if report.unknown() and operation in {"give", "attack", "unlock", "inspect", "take", "use"}:
                    report.add(FactCheckResult("known_prerequisites", "missing",
                                               "物理行动必须有明确位置和前提"))
                if states[actor_id]["interaction"]["stamina"] <= 0 and operation in {"give", "attack", "unlock", "inspect", "take", "use", "move"}:
                    report.add(FactCheckResult("stamina", "missing", "行动者需有精力",
                                               required="positive", found=0))
                if operation == "attack" and world["facts"].get("health:%s" % target, 0) <= 0:
                    report.add(FactCheckResult("target_incapacitated", "missing", "目标已无法继续受攻击"))
                if operation == "take" and str(world["facts"].get("location:%s" % target, "")).startswith("carried:"):
                    report.add(FactCheckResult("item_owned", "missing", "物品已由他人持有，不能直接拾取"))
                ev = evidence.get(target)
                laya = LayaEvidence(signals=ev["signals"],
                                    proposal_delta=ev["proposal"].get("delta", [])) if ev else None
                relation = states[target].get("relationship", {}) if target in ACTORS and actor_id == "player" else {}
                ctx = ResolutionContext(intent=raw["intent"], targets=[target],
                    actor_stats=states[actor_id]["interaction"]["stats"],
                    relationship=relation, environment=world["environment"],
                    resources={"stamina": states[actor_id]["interaction"]["stamina"]},
                    fact_report=report, laya=laya, evidence=raw.get("evidence", []))
                result = resolve(ctx)
                # Communicating is transmission, not the listener agreeing. Physical actions
                # remain governed by both the fact gate and the graduated result.
                achieved = result.result in GRADES_OK and report.all_ok()
                partial = result.result == "partial_success" and report.all_ok()
                if operation == "speak":
                    text = "话已传达；内容真伪和对方是否同意尚未判定" if achieved else "没有完成这次表达"
                    if achieved:
                        claim = {"type": "reported_claim", "speaker": actor_id,
                                 "listener": target, "content": raw.get("evidence", []), "verified": False}
                        facts_created.append(claim)
                        world["claims"].append(claim)
                elif operation == "persuade":
                    text = ("对方愿意继续商谈，未作具体承诺" if achieved else
                            "对方保留意见，愿意听更多依据" if partial else "对方没有答应这次请求")
                    if achieved or partial:
                        old = states[target]["interaction"].get("openness", "neutral")
                        new = "receptive" if achieved else "considering"
                        states[target]["interaction"]["openness"] = new
                        changes.append({"entity": target, "path": "interaction.openness",
                                        "before": old, "after": new, "source": "resolver"})
                    else:
                        opportunities.append("可以出示可核验的依据后重新请求。")
                elif operation == "give":
                    text = ("物品已交给 %s" % NAMES[target] if achieved else
                            "递出但未完成交接，物品仍归原持有人" if partial else "物品仍由原持有人持有")
                    if partial:
                        opportunities.append("可再次确认接收者愿意收下这件物品。")
                    if achieved:
                        for holder, value in ((actor_id, False), (target, True)):
                            key = "inventory:%s:%s" % (holder, object_id)
                            old = world["facts"].get(key)
                            world["facts"][key] = value
                            changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                            "before": old, "after": value, "source": "resolver"})
                        key = "location:%s" % object_id
                        old = world["facts"].get(key)
                        world["facts"][key] = "carried:%s" % target
                        changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                        "before": old, "after": world["facts"][key], "source": "resolver"})
                elif operation == "unlock":
                    text = "门已打开" if achieved else "锁已松动但门仍未打开" if partial else "锁仍未打开"
                    if achieved:
                        key = "entity:cellar_door:open"
                        world["facts"][key] = True
                        changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                        "before": False, "after": True, "source": "resolver"})
                    elif partial:
                        key = "entity:cellar_door:loosened"
                        old = world["facts"].get(key, False)
                        world["facts"][key] = True
                        changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                        "before": old, "after": True, "source": "resolver"})
                        opportunities.append("锁已松动，可继续尝试。")
                    else:
                        opportunities.append("可寻找匹配钥匙或其他入口。")
                elif operation == "attack":
                    text = "攻击命中" if achieved else "攻击未命中"
                    if report.all_ok():
                        stamina = states[actor_id]["interaction"]["stamina"]
                        states[actor_id]["interaction"]["stamina"] = stamina - 1
                        costs.append("%s 消耗 1 精力" % NAMES[actor_id])
                        changes.append({"entity": actor_id, "path": "interaction.stamina",
                                        "before": stamina, "after": stamina - 1, "source": "resolver"})
                    if achieved:
                        key = "health:%s" % target
                        old = world["facts"][key]
                        world["facts"][key] = max(0, old - 1)
                        changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                        "before": old, "after": world["facts"][key], "source": "resolver"})
                    else:
                        complications.append("攻击引起了在场者警觉。")
                        before = world["facts"]["scene:alert"]
                        world["facts"]["scene:alert"] = before + 1
                        changes.append({"entity": WORLD_ID, "path": "facts.scene:alert",
                                        "before": before, "after": before + 1, "source": "resolver"})
                elif operation == "inspect":
                    text = "完成检查" if achieved else "看到一些迹象，尚不足以确认" if partial else "检查未得出可靠结论"
                    if achieved:
                        facts_created.append({"type": "inspection", "observer": actor_id,
                                              "target": target, "known": True})
                elif operation == "move":
                    text = "已到达%s" % NAMES[target] if achieved else "在路上，尚未到达目的地" if partial else "尚未到达目的地"
                    if partial:
                        opportunities.append("可继续前往目的地。")
                    if achieved:
                        key = "location:%s" % actor_id
                        old = world["facts"].get(key)
                        world["facts"][key] = target
                        changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                        "before": old, "after": target, "source": "resolver"})
                elif operation == "take":
                    text = "已拾起%s" % NAMES[target] if achieved else "未取得该物品"
                    if achieved:
                        for key, value in (("inventory:%s:%s" % (actor_id, target), True),
                                           ("location:%s" % target, "carried:%s" % actor_id)):
                            old = world["facts"].get(key)
                            world["facts"][key] = value
                            changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                            "before": old, "after": value, "source": "resolver"})
                elif operation == "use":
                    text = "已用工具处理苹果" if achieved else "没有完成这次操作"
                    if achieved:
                        key = "entity:apple:cut"
                        old = world["facts"][key]
                        world["facts"][key] = True
                        changes.append({"entity": WORLD_ID, "path": "facts." + key,
                                        "before": old, "after": True, "source": "resolver"})
                else:
                    raise CoreError("OPERATION_UNKNOWN", "未知动作操作", 422)
                resolutions.append({"index": index, "intent": raw["intent"],
                    "operation": operation, "target_id": target, "fact_checks": report.to_dict(),
                    "resolution": result.to_dict(), "result_text": text})
        # Existing profile/State Transition is the only source of Laya relationship shifts.
        for target, ev in evidence.items():
            if not any(r["target_id"] == target and
                       all(c["status"] == "satisfied" for c in r["fact_checks"])
                       for r in resolutions):
                continue
            validated, skipped, preview = B.validate_state_delta(sid, target,
                ev["proposal"], {"source": "judgment", "behavior_is_null": False,
                                 "awaiting_upstream": False}, frozen_state=states[target])
            for row in validated:
                path = row["target"]
                old = B._dig(states[target], path)
                B._set_path(states[target], path, row["new_value"])
                changes.append({"entity": target, "path": path, "before": old,
                                "after": row["new_value"], "source": "laya:" + row["signal"]})
        if world["claims"] != original[WORLD_ID]["claims"]:
            changes.append({"entity": WORLD_ID, "path": "claims",
                            "before": original[WORLD_ID]["claims"], "after": _copy(world["claims"]),
                            "source": "reported_claims"})
        changes.append({"entity": WORLD_ID, "path": "turn",
                        "before": world["turn"], "after": world["turn"] + 1, "source": "turn_clock"})
        world["turn"] += 1
        grades = {r["resolution"]["result"] for r in resolutions}
        degree = next(iter(grades)) if len(grades) == 1 else "partial_success"
        result = {"result": "resolved", "degree": degree,
                  "completion": max((r["resolution"]["degree"] for r in resolutions), default=0),
                  "resolutions": resolutions, "facts_created": facts_created,
                  "state_changes": changes, "costs": costs, "complications": complications,
                  "opportunities": opportunities}
        return result, states

    def analyze(self, req):
        required = {"session_id", "event_id", "actor_id", "message", "expected_versions"}
        if not isinstance(req, dict) or set(req) != required:
            raise CoreError("BAD_INPUT", "分析字段不匹配")
        sid, event_id, actor_id, message = (req[k] for k in ("session_id", "event_id", "actor_id", "message"))
        if not all(isinstance(v, str) and v for v in (sid, event_id, actor_id, message)) or actor_id not in ACTORS:
            raise CoreError("BAD_INPUT", "会话、事件、角色、消息必须有效")
        if len(message) > 4000:
            raise CoreError("BAD_INPUT", "消息过长")
        key = (sid, event_id)
        with B.PROTOCOL.lock:
            self.pending = {k: p for k, p in self.pending.items() if p.expires_at >= time.time()}
            if self._event(*key).get("status") == "committed":
                raise CoreError("EVENT_COMMITTED", "该事件已提交", 409)
            states, versions = self._snapshot(sid)
            if versions != req["expected_versions"]:
                raise CoreError("STATE_VERSION_CONFLICT", "场景已变化", 409)
            for p in self.pending.values():
                if (p.session_id, p.event_id) == key:
                    if p.message != message or p.expected_versions != versions:
                        raise CoreError("EVENT_CONFLICT", "事件 ID 已对应其他输入", 409)
                    return self._preview(p)
            if key in self.inflight:
                raise CoreError("IN_PROGRESS", "该事件正在分析", 409)
            self.inflight.add(key)
        try:
            interpreted = self._interpret(message, states[WORLD_ID], actor_id)
            raw = interpreted.to_dict()
            if any(i["intent"] != "neutral" and not i.get("evidence") for i in raw["intents"]):
                raise CoreError("MISSING_EVIDENCE", "意图缺少可核对的原文依据", 502)
            target_messages = {}
            for intent in raw["intents"]:
                listeners = intent["targets"] or (["lia"] if actor_id == "player" and intent["operation"] in {"speak", "persuade"} else [])
                for name in listeners:
                    target = ALIASES.get(name)
                    if target in {"lia", "oren"}:
                        target_messages.setdefault(target, []).extend(intent.get("evidence") or [])
            target_messages = {k: "\n".join(dict.fromkeys(v)) for k, v in target_messages.items() if v}
            evidence, fingerprint = self._laya(sid, actor_id, states, target_messages)
            outcome, proposed = self._calculate(sid, actor_id, message, raw, evidence, states)
            p = Pending(uuid.uuid4().hex, sid, event_id, actor_id, message, versions,
                        raw, evidence, fingerprint, outcome, proposed, time.time() + 600)
            with B.PROTOCOL.lock:
                if self._snapshot(sid)[1] != versions:
                    raise CoreError("STATE_VERSION_CONFLICT", "分析期间场景变化", 409)
                self.pending[p.analysis_id] = p
            return self._preview(p)
        finally:
            with B.PROTOCOL.lock:
                self.inflight.discard(key)

    @staticmethod
    def _preview(p):
        return {"analysis_id": p.analysis_id, "status": "ready", "expires_at": p.expires_at,
                "interpretation": p.interpretation, "fact_resolution": p.outcome["resolutions"],
                "laya_evidence": p.evidence, "canonical_outcome": p.outcome,
                "proposed_states": p.states, "base_versions": p.expected_versions}

    def commit(self, req):
        if not isinstance(req, dict) or set(req) != {"session_id", "event_id", "analysis_id", "expected_versions"}:
            raise CoreError("BAD_COMMIT", "提交只接受分析引用与原版本")
        sid, event_id, analysis_id = (req[k] for k in ("session_id", "event_id", "analysis_id"))
        with B.PROTOCOL.lock:
            past = self._event(sid, event_id).get("b_receipt")
            if past:
                if past["analysis_id"] != analysis_id or past["base_versions"] != req["expected_versions"]:
                    raise CoreError("EVENT_CONFLICT", "提交引用与旧回执不符", 409)
                return dict(_copy(past), replayed=True)
            p = self.pending.get(analysis_id)
            if not p or (p.session_id, p.event_id) != (sid, event_id):
                raise CoreError("ANALYSIS_UNKNOWN", "候选不存在", 404)
            if p.expires_at < time.time():
                raise CoreError("ANALYSIS_EXPIRED", "候选已过期", 410)
            states, versions = self._snapshot(sid)
            if versions != p.expected_versions or versions != req["expected_versions"]:
                raise CoreError("STATE_VERSION_CONFLICT", "状态变化后须重新分析", 409)
            if p.rules_fingerprint and B.PROTOCOL.rules_fingerprint(B.PROTOCOL._effective_model()) != p.rules_fingerprint:
                raise CoreError("RULESET_CHANGED", "Laya 档案或规则已变化", 409)
            check, new_states = self._calculate(sid, p.actor_id, p.message, p.interpretation, p.evidence, states)
            if check != p.outcome or new_states != p.states:
                raise CoreError("PROPOSAL_CHANGED", "当前重验与原结果不一致", 409)
            new_states[WORLD_ID]["history"] = (new_states[WORLD_ID]["history"] + [
                {"role": "user", "content": p.message},
                {"role": "assistant", "content": _narrate(check)}])[-12:]
            commit_id = "b_" + uuid.uuid4().hex
            receipt = {"status": "committed", "replayed": False, "commit_id": commit_id,
                       "analysis_id": analysis_id, "event_id": event_id, "session_id": sid,
                       "base_versions": versions, "canonical_outcome": check,
                       "trace": {"message": p.message, "interpretation": p.interpretation,
                                 "facts_and_resolution": check["resolutions"], "laya_evidence": p.evidence}}
            # One publication: the same lock and version authority as existing Laya routes.
            changed = {WORLD_ID, p.actor_id} | {c["entity"] for c in check["state_changes"]}
            saved = {e: (_copy(B._ACTOR_STATE.get((sid, e))),
                          _copy(B._STATE_TRACE.get((sid, e))),
                          _copy(B.PROTOCOL._ensure_bucket_meta((sid, e)))) for e in changed}
            previous_event = _copy(B.PROTOCOL._events.get((sid, WORLD_ID)))
            try:
                updated = dict(versions)
                for e in changed:
                    scope = (sid, e)
                    B._ACTOR_STATE[scope] = _copy(new_states[e])
                    updated[e] = B.PROTOCOL._bump_revision(scope)
                    B._STATE_TRACE.setdefault(scope, []).append({"kind": "interaction_b",
                        "commit_id": commit_id, "event_id": event_id,
                        "before_version": versions[e], "after_version": updated[e],
                        "outcome": check})
                    B._STATE_TRACE[scope] = B._STATE_TRACE[scope][-(B._STATE_TRACE_MAX):]
                receipt["versions"] = updated
                receipt["states"] = _copy(new_states)
                B.PROTOCOL._events.setdefault((sid, WORLD_ID), {})[event_id] = {
                    "status": "committed", "b_receipt": _copy(receipt)}
            except Exception:
                for e, (old_state, old_trace, old_meta) in saved.items():
                    scope = (sid, e)
                    if old_state is None: B._ACTOR_STATE.pop(scope, None)
                    else: B._ACTOR_STATE[scope] = old_state
                    if old_trace is None: B._STATE_TRACE.pop(scope, None)
                    else: B._STATE_TRACE[scope] = old_trace
                    B.PROTOCOL._buckets[scope] = old_meta
                if previous_event is None: B.PROTOCOL._events.pop((sid, WORLD_ID), None)
                else: B.PROTOCOL._events[(sid, WORLD_ID)] = previous_event
                raise
            self.pending.pop(analysis_id, None)
            return receipt

    def narrate(self, req):
        if not isinstance(req, dict) or set(req) != {"session_id", "event_id"}:
            raise CoreError("BAD_NARRATE", "只接受会话和事件 ID")
        with B.PROTOCOL.lock:
            receipt = self._event(req["session_id"], req["event_id"]).get("b_receipt")
            if not receipt:
                raise CoreError("OUTCOME_UNCOMMITTED", "该事件尚未提交", 409)
            return {"commit_id": receipt["commit_id"], "text": _narrate(receipt["canonical_outcome"]),
                    "source": "committed_outcome", "canonical_outcome": receipt["canonical_outcome"]}

    def receipt(self, sid, event_id):
        with B.PROTOCOL.lock:
            found = self._event(sid, event_id).get("b_receipt")
            if not found:
                raise CoreError("RECEIPT_UNKNOWN", "没有该事件的已提交回执", 404)
            return _copy(found)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Candidate B interaction demo")
    parser.add_argument("--port", type=int, default=8133)
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    if args.env_file:
        B.load_env_file(args.env_file)
    B.ENGINE.init()
    if not B.ENGINE.ready:
        raise SystemExit("Laya 未加载；请指定现有模型目录与 CUDA 环境")
    service = InteractionB()

    class Handler(B.Handler):
        def send(self, call):
            try:
                return self._json(call())
            except CoreError as e:
                return self._json({"error": {"code": e.code, "message": str(e)}}, e.http)
            except B._ProtoError as e:
                return self._json(e.body(), e.http)
            except Exception as e:
                return self._json({"error": {"code": "INTERNAL_ERROR", "message": type(e).__name__}}, 500)

        def do_GET(self):
            uri = urlparse(self.path)
            if uri.path == "/b/demo":
                content = (Path(__file__).parent / "b_demo.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                return self.wfile.write(content)
            if uri.path == "/b/state":
                sid = parse_qs(uri.query).get("session_id", [""])[0]
                return self.send(lambda: service.state(sid))
            if uri.path == "/b/receipt":
                q = parse_qs(uri.query)
                return self.send(lambda: service.receipt(q.get("session_id", [""])[0],
                                                         q.get("event_id", [""])[0]))
            return super().do_GET()

        def do_POST(self):
            paths = {"/b/analyze": service.analyze, "/b/commit": service.commit,
                     "/b/narrate": service.narrate}
            op = paths.get(urlparse(self.path).path)
            if op:
                return self.send(lambda: op(self._read_protocol()))
            return super().do_POST()

    print("Candidate B http://127.0.0.1:%s/b/demo" % args.port)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
