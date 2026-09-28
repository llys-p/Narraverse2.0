"""P2-B1 场景动作规则链定向检查：零模型、零云端、零 HTTP。"""
import copy
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_delivery_core import WORLD, DeliveryCore


def fresh(sid):
    B.reset_actor_state()
    B.reset_history()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)
    return core, sid


def prepare(core, sid, actions, event="scene-event"):
    return core.prepare_structured({
        "session_id": sid, "event_id": event, "actor_id": "player",
        "expected_versions": core.state(sid)["versions"], "actions": actions,
    })


def action(aid, op, targets=None, obj=None, **kw):
    return {"id": aid, "operation": op, "target_ids": targets or [],
            "object_id": obj, **kw}


def main():
    failures = []
    count = 0

    def check(name, condition, detail=""):
        nonlocal count
        count += 1
        print("%s [%s] %s" % ("PASS" if condition else "FAIL", name, detail))
        if not condition:
            failures.append(name)

    sid = "p2b1-chain"
    core, sid = fresh(sid)
    before = copy.deepcopy(B._ACTOR_STATE)
    pv = prepare(core, sid, [
        action("m1", "move", ["old_well"]),
        action("t1", "take", obj="cellar_key", depends_on="m1", when="if_achieved"),
        action("m2", "move", ["tavern"], depends_on="t1", when="if_achieved"),
        action("u1", "unlock", obj="cellar_door", depends_on="m2", when="if_achieved"),
    ])
    check("prepare_zero_write", B._ACTOR_STATE == before,
          "prepare must only simulate")
    check("complete_chain_ready", pv["status"] == "ready" and pv["can_commit"],
          str(pv["reason_codes"]))
    rs = pv["outcome"]["resolutions"]
    check("execution_status_separate", all(r.get("execution_status") == "attempted"
          and r.get("degree") == "success" for r in rs), repr(rs))
    rec = core.commit({"session_id": sid, "event_id": "scene-event",
                       "analysis_id": pv["analysis_id"],
                       "expected_versions": pv["base_versions"]})
    states = core.state(sid)["states"]
    world = states[WORLD]["interaction"]
    check("chain_commit_effects", states["player"]["interaction"]["location"] == "tavern"
          and world["objects"]["cellar_key"]["owner"] == "player"
          and world["objects"]["cellar_door"]["locked"] is False
          and world["objects"]["cellar_door"]["open"] is True,
          repr(rec["outcome"]["state_changes"]))
    replay = core.commit({"session_id": sid, "event_id": "scene-event",
                          "analysis_id": pv["analysis_id"],
                          "expected_versions": pv["base_versions"]})
    check("replay_idempotent", replay.get("replayed") is True
          and world["turn_tick"] == 1, str(replay.get("replayed")))

    core, sid = fresh("p2b1-premise")
    pv = prepare(core, sid, [action("t", "take", obj="cellar_key")], "wrong-place")
    r = pv["outcome"]["resolutions"][0]
    check("take_wrong_place_blocked_null_degree", r.get("execution_status") == "blocked"
          and r.get("degree") is None and pv["status"] == "blocked", repr(r))
    B._ACTOR_STATE[(sid, WORLD)]["interaction"]["objects"]["cellar_key"]["owner"] = "lia"
    pv = prepare(core, sid, [
        action("go", "move", ["old_well"]),
        action("t", "take", obj="cellar_key", depends_on="go", when="if_achieved"),
    ], "already-held")
    r = pv["outcome"]["resolutions"][1]
    check("take_item_held_by_other_blocked", r.get("execution_status") == "blocked"
          and "item_not_available" in r["check"]["reasons"], repr(r))
    core, sid = fresh("p2b1-premise")
    pv = prepare(core, sid, [action("badmove", "move", ["moon"])], "unknown-place")
    r = pv["outcome"]["resolutions"][0]
    check("unknown_place_blocked", r.get("execution_status") == "blocked"
          and "location_unknown" in r["check"]["reasons"], repr(r))
    pv = prepare(core, sid, [action("unl", "unlock", obj="cellar_door")], "no-key")
    r = pv["outcome"]["resolutions"][0]
    check("unlock_without_key_blocked", r.get("execution_status") == "blocked"
          and "key_not_owned" in r["check"]["reasons"], repr(r))
    pv = prepare(core, sid, [
        action("m", "move", ["old_well"]),
        action("t", "take", obj="cellar_key", depends_on="m", when="if_achieved"),
        action("u", "unlock", obj="cellar_door", depends_on="t", when="if_achieved"),
    ], "conditional")
    r = pv["outcome"]["resolutions"][-1]
    check("move_then_take_unlock_wrong_location", r.get("execution_status") == "blocked"
          and r.get("degree") is None and "door_out_of_reach" in r["check"]["reasons"], repr(r))

    # When a prerequisite is blocked, dependent physical effects are skipped.
    core, sid = fresh("p2b1-dependency")
    pv = prepare(core, sid, [
        action("bad", "move", ["moon"]),
        action("take", "take", obj="cellar_key", depends_on="bad", when="if_achieved"),
    ], "dependency")
    blocked, skipped = pv["outcome"]["resolutions"]
    check("failed_dependency_skips", skipped.get("execution_status") == "skipped"
          and skipped.get("degree") is None
          and core.state(sid)["states"][WORLD]["interaction"]["objects"]["cellar_key"]["owner"] is None,
          repr(skipped))
    pv = prepare(core, sid, [
        action("bad", "move", ["moon"]),
        action("fallback", "move", ["old_well"], depends_on="bad", when="if_not_achieved"),
    ], "conditional-fallback")
    check("if_not_achieved_runs", pv["outcome"]["resolutions"][1].get("execution_status") == "attempted"
          and pv["outcome"]["resolutions"][1].get("degree") == "success", repr(pv["outcome"]["resolutions"]))

    try:
        prepare(core, sid, [
            action("a", "move", ["old_well"], when="if_achieved"),
        ], "invalid-when")
        valid = False
    except Exception:
        valid = True
    check("condition_requires_dependency", valid)
    try:
        prepare(core, sid, [
            action("a", "move", ["old_well"], depends_on="later"),
            action("later", "take", obj="cellar_key"),
        ], "forward-dependency")
        valid = False
    except Exception:
        valid = True
    check("dependency_must_point_backward", valid)

    # A failed multi-entity release must leave location, ownership, door, versions and tick intact.
    core, sid = fresh("p2b1-rollback")
    pv = prepare(core, sid, [
        action("m1", "move", ["old_well"]),
        action("t1", "take", obj="cellar_key", depends_on="m1", when="if_achieved"),
        action("m2", "move", ["tavern"], depends_on="t1", when="if_achieved"),
        action("u1", "unlock", obj="cellar_door", depends_on="m2", when="if_achieved"),
    ], "rollback")
    before = copy.deepcopy(B._ACTOR_STATE)
    before_versions = core.state(sid)["versions"]
    try:
        with mock.patch.object(core.P, "commit_multi_entity_bundle",
                               side_effect=RuntimeError("injected release failure")):
            core.commit({"session_id": sid, "event_id": "rollback",
                         "analysis_id": pv["analysis_id"],
                         "expected_versions": pv["base_versions"]})
        rolled_back = False
    except Exception:
        rolled_back = (B._ACTOR_STATE == before
                       and core.state(sid)["versions"] == before_versions
                       and core.state(sid)["states"][WORLD]["interaction"]["turn_tick"] == 0)
    check("full_chain_commit_failure_rolls_back", rolled_back)

    print("SUMMARY %d checks, %d failures" % (count, len(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
