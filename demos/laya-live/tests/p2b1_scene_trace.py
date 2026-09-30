"""P2-B1 readable local trace for the deterministic move/take/move/unlock chain."""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_delivery_core import WORLD, DeliveryCore


def main():
    B.reset_actor_state()
    B.reset_history()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    sid = "p2b1-trace"
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)
    actions = [
        {"id": "m1", "operation": "move", "target_ids": ["old_well"]},
        {"id": "t1", "operation": "take", "object_id": "cellar_key",
         "depends_on": "m1", "when": "if_achieved"},
        {"id": "m2", "operation": "move", "target_ids": ["tavern"],
         "depends_on": "t1", "when": "if_achieved"},
        {"id": "u1", "operation": "unlock", "object_id": "cellar_door",
         "depends_on": "m2", "when": "if_achieved"},
    ]
    initial = core.state(sid)
    preview = core.prepare_structured({
        "session_id": sid, "event_id": "trace-event", "actor_id": "player",
        "expected_versions": initial["versions"], "actions": actions,
    })
    rows = [
        "P2-B1 trace | model=none | cloud=none",
        "session=%s event=trace-event prepare=%s can_commit=%s" %
        (sid, preview["status"], preview["can_commit"]),
        "before: player.location=%s key.owner=%s door.locked=%s door.open=%s tick=%s" % (
            initial["states"]["player"]["interaction"]["location"],
            initial["states"][WORLD]["interaction"]["objects"]["cellar_key"]["owner"],
            initial["states"][WORLD]["interaction"]["objects"]["cellar_door"]["locked"],
            initial["states"][WORLD]["interaction"]["objects"]["cellar_door"]["open"],
            initial["states"][WORLD]["interaction"]["turn_tick"]),
    ]
    for resolution in preview["outcome"]["resolutions"]:
        rows.append("%s %-6s execution=%-9s degree=%-6s reasons=%s" % (
            resolution["action_id"], resolution["operation"],
            resolution["execution_status"], resolution["degree"],
            ",".join(resolution["check"]["reasons"]) or "-"))
    rows.append("prepare_zero_write=%s" % (initial["states"] == core.state(sid)["states"]))
    receipt = core.commit({
        "session_id": sid, "event_id": "trace-event",
        "analysis_id": preview["analysis_id"],
        "expected_versions": preview["base_versions"],
    })
    after = core.state(sid)
    wi = after["states"][WORLD]["interaction"]
    rows.append("commit=%s replayed=%s tick=%s" %
                 (receipt["status"], receipt["replayed"], wi["turn_tick"]))
    rows.append("after: player.location=%s key.owner=%s door.locked=%s door.open=%s" % (
        after["states"]["player"]["interaction"]["location"],
        wi["objects"]["cellar_key"]["owner"], wi["objects"]["cellar_door"]["locked"],
        wi["objects"]["cellar_door"]["open"]))
    replay = core.commit({
        "session_id": sid, "event_id": "trace-event",
        "analysis_id": preview["analysis_id"],
        "expected_versions": preview["base_versions"],
    })
    rows.append("repeat_commit_replayed=%s tick_still=%s" %
                 (replay["replayed"], core.state(sid)["states"][WORLD]["interaction"]["turn_tick"]))
    output = "\n".join(rows) + "\n"
    out_dir = Path(__file__).resolve().parent.parent / "_diag"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ("p2b1_scene_trace_%s.txt" % time.strftime("%Y%m%d_%H%M%S"))
    out.write_text(output, encoding="utf-8")
    print(output, end="")
    print("trace_file=%s" % out)
    return 0 if (preview["status"] == "ready" and receipt["status"] == "committed"
                 and replay.get("replayed") is True and wi["objects"]["cellar_door"]["open"] is True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
