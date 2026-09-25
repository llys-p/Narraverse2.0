"""Turn orchestration. Prepare is pure w.r.t. game state; commit is the sole writer."""
import hashlib
import json
import time
import uuid
from copy import deepcopy
from dataclasses import dataclass, replace

from .contracts import (CanonicalOutcome, CommitResult, CoreError, LayaEvidence, SceneSnapshot,
                        StateChange, StateProposal, TurnInput, TurnInterpretation, wire)
from .narration import StoryAgent
from .rules import WORLD, check_facts, get_path, resolve_turn, set_path


@dataclass
class PendingTurn:
    id: str
    turn: TurnInput
    snapshot: SceneSnapshot
    interpretation: TurnInterpretation
    evidence: tuple[LayaEvidence, ...]
    outcome: CanonicalOutcome
    proposal: StateProposal
    expires_at: float
    request_hash: str


class InteractionCore:
    def __init__(self, store, interpreter, evidence, story=None, now=None):
        self.store, self.interpreter, self.evidence = store, interpreter, evidence
        self.story = story or StoryAgent()
        self.now = now or time.time
        self.pending = {}  # metadata only; all game state lives in existing Actor State
        self.inflight = set()

    @staticmethod
    def parse_input(req):
        required = {"session_id", "event_id", "actor_id", "message", "expected_versions"}
        if not isinstance(req, dict) or set(req) != required:
            raise CoreError("TURN_INPUT", "请求字段必须为 " + ", ".join(sorted(required)))
        for key in ("session_id", "event_id", "actor_id"):
            value = req[key]
            if not isinstance(value, str) or not 1 <= len(value) <= 64 or not all(c.isascii() and (c.isalnum() or c in "_-") for c in value):
                raise CoreError("TURN_INPUT", key + " 必须为 1–64 位字母、数字、下划线或连字符")
        if not isinstance(req["message"], str) or not 1 <= len(req["message"]) <= 4000:
            raise CoreError("TURN_INPUT", "message 必须为 1–4000 字符")
        if not isinstance(req["expected_versions"], dict):
            raise CoreError("TURN_INPUT", "expected_versions 必须为版本映射")
        return TurnInput(**deepcopy(req))

    def state(self, session_id):
        if not isinstance(session_id, str) or not session_id or len(session_id) > 64:
            raise CoreError("SCOPE", "session_id 不合法")
        return wire(self.store.snapshot(session_id))

    def prepare(self, req):
        turn = self.parse_input(req)
        digest = hashlib.sha256(json.dumps(req, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
        key = (turn.session_id, turn.event_id)
        with self.store.protocol.lock:
            self.pending = {k: v for k, v in self.pending.items() if v.expires_at > self.now()}
            if self.store.receipt(*key):
                raise CoreError("EVENT_COMMITTED", "事件已提交；可用 session_id/event_id 读取回执", 409)
            snapshot = self.store.snapshot(turn.session_id)
            if turn.expected_versions != snapshot.versions:
                raise CoreError("STATE_VERSION_CONFLICT", "请刷新场景版本", 409)
            if turn.actor_id not in snapshot.states or turn.actor_id == WORLD:
                raise CoreError("ACTOR_UNKNOWN", "未知行动角色")
            for candidate in self.pending.values():
                if (candidate.turn.session_id, candidate.turn.event_id) == key:
                    if candidate.request_hash != digest:
                        raise CoreError("EVENT_CONFLICT", "同一 event_id 的输入已经改变", 409)
                    return self.preview(candidate)
            if key in self.inflight:
                raise CoreError("IN_PROGRESS", "该事件正在分析", 409)
            if len(self.pending) + len(self.inflight) >= 200:
                raise CoreError("CAPACITY", "候选已满，请等待过期", 429)
            self.inflight.add(key)
        try:
            interpretation = self.interpreter.interpret(turn, snapshot)
            if interpretation.ambiguities:
                raise CoreError("NEEDS_CLARIFICATION", "；".join(interpretation.ambiguities), 409)
            # Initial checks select actual, reachable NPC recipients. Resolver checks again
            # in sequential state, so one transferred item cannot be spent twice.
            targets = sorted({target for action in interpretation.actions for target in action.target_ids
                if target in snapshot.states and target not in {WORLD, turn.actor_id}
                and check_facts(action, target, snapshot.states).allowed})
            evidence = self.evidence.evaluate(turn, interpretation, snapshot, tuple(targets))
            outcome, proposal = self.calculate(turn, interpretation, snapshot, evidence)
            candidate = PendingTurn(uuid.uuid4().hex, turn, snapshot, interpretation, evidence,
                                    outcome, proposal, self.now() + 600, digest)
            with self.store.protocol.lock:
                if self.store.snapshot(turn.session_id).versions != turn.expected_versions:
                    raise CoreError("STATE_VERSION_CONFLICT", "计算期间状态发生变化", 409)
                self.pending[candidate.id] = candidate
            return self.preview(candidate)
        finally:
            with self.store.protocol.lock:
                self.inflight.discard(key)

    def calculate(self, turn, interpretation, snapshot, evidence):
        outcome = resolve_turn(turn, interpretation, snapshot, evidence)
        changes = list(outcome.state_changes)
        for entity, row in self.evidence.validate(turn, evidence, snapshot):
            changes.append(StateChange(entity, row["target"], row["old"], row["new_value"],
                                       "laya:" + row["signal"]))
        world = snapshot.states[WORLD]["interaction"]
        changes.append(StateChange(WORLD, "interaction.turn_tick", world["turn_tick"],
                                   world["turn_tick"] + 1, "turn_clock"))
        changes.append(StateChange(WORLD, "interaction.facts", world["facts"],
                                   (world["facts"] + list(outcome.facts_created))[-100:], "canonical_facts"))
        outcome = replace(outcome, state_changes=tuple(changes))
        return outcome, StateProposal(dict(snapshot.versions), tuple(changes))

    @staticmethod
    def preview(candidate):
        c = candidate
        return {"analysis_id": c.id, "status": "ready", "expires_at": c.expires_at,
                "state_proposal": wire(c.proposal), "outcome": wire(c.outcome),
                "trace": {"raw_input": wire(c.turn), "interpretation": wire(c.interpretation),
                          "fact_checks": [wire(r.check) for r in c.outcome.resolutions],
                          "laya_evidence": [wire(e) for e in c.evidence],
                          "resolution_context": [wire(r.context) for r in c.outcome.resolutions]}}

    def commit(self, req):
        if set(req) != {"session_id", "event_id", "analysis_id", "expected_versions"}:
            raise CoreError("COMMIT_INPUT", "Commit 只接受 scope/event/analysis 引用与版本")
        with self.store.protocol.lock:
            receipt = self.store.receipt(req["session_id"], req["event_id"])
            if receipt:
                if receipt["analysis_id"] != req["analysis_id"] or receipt["base_versions"] != req["expected_versions"]:
                    raise CoreError("EVENT_CONFLICT", "提交引用与已有回执不匹配", 409)
                return dict(receipt, replayed=True)
            c = self.pending.get(req["analysis_id"])
            if not c or c.turn.session_id != req["session_id"] or c.turn.event_id != req["event_id"]:
                raise CoreError("ANALYSIS_UNKNOWN", "未找到该作用域候选", 404)
            if c.expires_at <= self.now():
                raise CoreError("ANALYSIS_EXPIRED", "候选已经过期", 410)
            current = self.store.snapshot(c.turn.session_id)
            if current.versions != req["expected_versions"] or current.versions != c.snapshot.versions:
                raise CoreError("STATE_VERSION_CONFLICT", "状态已变化，请重分析", 409)
            outcome, proposal = self.calculate(c.turn, c.interpretation, current, c.evidence)
            if wire(proposal) != wire(c.proposal) or wire(outcome) != wire(c.outcome):
                raise CoreError("PROPOSAL_CHANGED", "重验结果与预览不同", 409)
            states = deepcopy(current.states)
            touched = {WORLD}
            for change in proposal.changes:
                if get_path(states[change.entity_id], change.path) != change.before:
                    raise CoreError("PROPOSAL_CONFLICT", "动作序列中的前置状态不一致", 409)
                set_path(states[change.entity_id], change.path, change.after)
                touched.add(change.entity_id)
            commit_id = "ic_" + uuid.uuid4().hex
            receipt = wire(CommitResult(commit_id, c.turn.event_id, dict(current.versions), outcome, states))
            receipt["analysis_id"] = c.id
            # Deterministic narration is reproducible from the committed receipt; store it
            # in the same transaction as dialogue history. Cloud rendering is optional later.
            text = StoryAgent().narrate(receipt)["text"]
            conversation = states[WORLD]["interaction"]["conversation"]
            states[WORLD]["interaction"]["conversation"] = (conversation + [
                {"role": "user", "content": c.turn.message},
                {"role": "assistant", "content": text}])[-12:]
            receipt["states"] = deepcopy(states)
            receipt["trace"] = dict(self.preview(c)["trace"], canonical_outcome=wire(outcome),
                                    state_proposal=wire(proposal))
            result = self.store.publish(c.turn, {k: states[k] for k in touched},
                                        {"kind": "interaction_core", "event_id": c.turn.event_id,
                                         "commit_id": commit_id, "outcome": wire(outcome)}, receipt)
            self.pending.pop(c.id, None)
            return result

    def get_receipt(self, session_id, event_id):
        with self.store.protocol.lock:
            receipt = self.store.receipt(session_id, event_id)
            if not receipt:
                raise CoreError("RECEIPT_UNKNOWN", "未找到已提交回执", 404)
            return receipt

    def narrate(self, req):
        # No client-supplied outcome, text or numeric delta can enter the story authority.
        if set(req) != {"session_id", "event_id"}:
            raise CoreError("NARRATE_INPUT", "只接受 session_id 和 event_id")
        return self.story.narrate(self.get_receipt(req["session_id"], req["event_id"]))
