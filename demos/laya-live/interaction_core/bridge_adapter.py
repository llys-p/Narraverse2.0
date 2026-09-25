"""Adapter to existing Laya and Actor State. No second actor/world state database."""
import json
from copy import deepcopy

from .contracts import CoreError, LayaEvidence, SceneSnapshot
from .rules import WORLD


class BridgeStore:
    def __init__(self, B, templates):
        self.B, self.protocol = B, B.PROTOCOL
        self.templates = deepcopy(templates)

    def snapshot(self, session_id):
        with self.protocol.lock:
            states, versions = {}, {}
            for entity, template in self.templates.items():
                scope = (session_id, entity)
                # Legacy actor buckets can precede interaction gameplay initialization.
                state = deepcopy(template)
                state.update(deepcopy(self.B._ACTOR_STATE.get(scope, {})))
                states[entity] = state
                versions[entity] = self.protocol.state_version(scope)
            history = states[WORLD]["interaction"]["conversation"]
            return SceneSnapshot(versions, states, tuple(deepcopy(history[-12:])))

    def receipt(self, session_id, event_id):
        record = self.protocol._events.get((session_id, WORLD), {}).get(event_id, {})
        return deepcopy(record.get("interaction_receipt"))

    def publish(self, turn, new_states, trace, receipt):
        """Called by Validate/Commit only. Reuses protocol lock, versions, trace and events."""
        return self.protocol.commit_interaction_bundle(
            turn.session_id, WORLD, turn.event_id, turn.expected_versions,
            new_states, trace, receipt)


class BridgeEvidence:
    def __init__(self, B):
        self.B = B

    def evaluate(self, turn, interpretation, scene, targets):
        B = self.B
        # Existing profiles describe NPC response to the player, not arbitrary NPC pairs.
        targets = tuple(t for t in targets if scene.states[t]["interaction"].get("relationship_to") == turn.actor_id)
        if not targets:
            return ()
        model = B.PROTOCOL._effective_model()
        B.PROTOCOL._assert_engine(model)
        fingerprint = B.PROTOCOL.rules_fingerprint(model)
        cache = {}
        if B._XLATE_DISK.exists():
            cache = json.loads(B._XLATE_DISK.read_text(encoding="utf-8"))
        profile, check = B.load_capability_profile(model)
        if not check.get("fresh") or not check.get("matched"):
            raise CoreError("PROFILE_UNAVAILABLE", "能力档案与当前资产不匹配", 409)
        results = []
        for target in targets:
            state = scene.states[target]
            # Reuse analyzer questions and translation; the old regex adjudicator is bypassed.
            # Explicit semantic actions are context, never a replacement for raw dialogue.
            relevant = [a for a in interpretation.actions if target in a.target_ids and a.mode == "attempt"]
            utterance = "\n".join(dict.fromkeys(a.evidence for a in relevant))
            english = B._cached_translate(utterance, cache)
            if english is None:
                raise CoreError("TRANSLATION_FAILED", "无法取得译文", 502)
            structured = [{"kind": a.kind, "operation": a.operation} for a in relevant[:4]]
            actor = deepcopy(B.CFG.get("actor", {}))
            actor.update(deepcopy(state))
            actor.update(identity="当前场景中的角色", identity_en="a character in the current scene")
            core = B.analyze_core({"session_id": turn.session_id, "actor_id": target,
                "actor": actor, "player_input": utterance, "player_input_en": english,
                "history": list(scene.history), "world_state": {"interpreted_actions": structured}},
                frozen_state=state, legacy_adjudication=False)
            if core.get("engine") != B.ENGINE_MODE_LAYA or core.get("ok") is False:
                raise CoreError("MODEL_UNAVAILABLE", "Laya 本轮推理失败，未创建候选", 503)
            signals = core.get("signal_values", {})
            statuses = {k: v.get("status") for k, v in profile.get("signals", {}).items()}
            # Only active behavior tendencies enter resolution, auxiliary stays visible evidence.
            tendency = 0.0
            for name, direction in (("cooperation", 1), ("hostility", -1)):
                if statuses.get(name) == "active" and isinstance(signals.get(name), (float, int)):
                    tendency += direction * signals[name]
            results.append(LayaEvidence(target, model, fingerprint,
                {"values": signals, "capability": profile.get("signals", {})},
                core["state_proposal"], max(-1, min(1, tendency))))
        return tuple(results)

    def validate(self, turn, evidence, snapshot):
        """Reuses capability check and State Transition both during preview and commit."""
        B = self.B
        rows = []
        for item in evidence:
            B.PROTOCOL._assert_engine(item.checkpoint)
            if B.PROTOCOL.rules_fingerprint(item.checkpoint) != item.rules_fingerprint:
                raise CoreError("RULESET_CHANGED", "Laya 规则/档案已变化，请重新分析", 409)
            commits, skipped, _ = B.validate_state_delta(turn.session_id, item.actor_id,
                item.proposal, {"source": "judgment", "behavior_is_null": False,
                               "awaiting_upstream": False},
                frozen_state=snapshot.states[item.actor_id])
            rows.extend((item.actor_id, c) for c in commits)
        return rows


class NoEvidence:
    """Explicit rules-only launch mode, never impersonates Laya or produces state shifts."""
    def evaluate(self, turn, interpretation, scene, targets):
        return ()

    def validate(self, turn, evidence, snapshot):
        return []
