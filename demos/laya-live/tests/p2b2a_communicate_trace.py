"""P2-B2a readable trace：询问 → 权威回执 → 下一轮可读 → 观察/声明边界。

零模型、零云端、零 HTTP、零 Laya；只跑一条可读链加三组反例，把「哪些内容进了
私有 knowledge、哪些只进公开回合描述符」逐行打出来。
"""
import copy
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
from laya_delivery_core import WORLD, DeliveryCore

OUT = []


def line(text=""):
    OUT.append(text)
    print(text)


def rule(title):
    line("")
    line("─" * 78)
    line(title)
    line("─" * 78)


def world_of(core, sid):
    return core.state(sid)["states"][WORLD]["interaction"]


def prepare(core, sid, actions, event):
    return core.prepare_structured({
        "session_id": sid, "event_id": event, "actor_id": "player",
        "expected_versions": core.state(sid)["versions"], "actions": actions,
    })


def commit(core, sid, pv, event):
    return core.commit({"session_id": sid, "event_id": event,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})


def show_resolutions(pv):
    for r in pv["outcome"]["resolutions"]:
        line("    %-4s %-11s execution=%-9s degree=%-7s reasons=%s" % (
            r["action_id"], r["operation"], r["execution_status"], r["degree"],
            ",".join(r["check"]["reasons"]) or "-"))


def show_changes(pv):
    for ch in pv["state_proposal"]["changes"]:
        line("    %-9s %-34s %s -> %s" % (
            ch["entity_id"], ch["path"], _short(ch["before"]), _short(ch["after"])))


def _short(value):
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 46 else text[:43] + "…"


def main():
    B.reset_actor_state()
    B.reset_history()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    sid = "p2b2a-trace"
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)

    line("P2-B2a trace | model=none | cloud=none | laya=none")
    line("session=%s protocol=%s rules_fingerprint=%s"
         % (sid, core.state(sid)["protocol_version"], core.rules_fingerprint()[:16]))
    line("初始：player.location=%s  lia.location=%s  key.owner=%s  door.locked=%s  tick=%s"
         % (core.state(sid)["states"]["player"]["interaction"]["location"],
            core.state(sid)["states"]["lia"]["interaction"]["location"],
            world_of(core, sid)["objects"]["cellar_key"]["owner"],
            world_of(core, sid)["objects"]["cellar_door"]["locked"],
            world_of(core, sid)["turn_tick"]))
    line("莉亚的作者化线索：%s" % json.dumps(
        [e for e in core.knowledge(sid, "lia")["entries"]], ensure_ascii=False))

    # ---------------------------------------------------------------- ① 询问
    rule("① 向莉亚询问（communicate / question）")
    before = copy.deepcopy(B._ACTOR_STATE)
    pv = prepare(core, sid, [{"id": "a1", "operation": "communicate",
                              "target_ids": ["lia"], "object_id": "cellar_key",
                              "mode": "attempt", "kind": "question",
                              "content": "钥匙在哪", "evidence": "钥匙在哪"}], "trace-ask")
    line("  prepare=%s can_commit=%s reason=%s"
         % (pv["status"], pv["can_commit"], pv["reason_codes"]))
    show_resolutions(pv)
    line("  写项（Prepare 只在副本上算，未落盘）：")
    show_changes(pv)
    line("  prepare_zero_write=%s" % (B._ACTOR_STATE == before))

    rec = commit(core, sid, pv, "trace-ask")
    line("  commit=%s commit_id=%s tick=%s"
         % (rec["status"], rec["commit_id"], world_of(core, sid)["turn_tick"]))
    line("  权威回执 knowledge_gained=%s"
         % json.dumps(rec["knowledge_gained"], ensure_ascii=False))
    line("  权威回执 acts=%s" % json.dumps(rec["acts"], ensure_ascii=False))
    line("  下一轮 core.knowledge(session,'player')=%s"
         % json.dumps(core.knowledge(sid, "player")["entries"], ensure_ascii=False))
    line("  世界回合记录（脱敏视图）=%s"
         % json.dumps(world_of(core, sid)["turns"], ensure_ascii=False))
    line("  客观 world.facts=%s"
         % json.dumps(world_of(core, sid)["facts"], ensure_ascii=False))
    line("  线索是否替玩家动作：key.owner=%s  player.location=%s（都未变）"
         % (world_of(core, sid)["objects"]["cellar_key"]["owner"],
            core.state(sid)["states"]["player"]["interaction"]["location"]))

    # ------------------------------------------------- ② 反例：远距 / 不可见
    rule("② 反例：远距询问、在酒馆观察旧井的钥匙")
    pv = prepare(core, sid, [{"id": "m1", "operation": "move",
                              "target_ids": ["old_well"], "object_id": None}], "trace-go")
    commit(core, sid, pv, "trace-go")
    line("  玩家已移动到 %s"
         % core.state(sid)["states"]["player"]["interaction"]["location"])
    pv = prepare(core, sid, [{"id": "a1", "operation": "communicate",
                              "target_ids": ["lia"], "object_id": None,
                              "mode": "attempt", "kind": "question",
                              "content": "钥匙在哪"}], "trace-remote-ask")
    line("  远距询问 prepare=%s reason=%s" % (pv["status"], pv["reason_codes"]))
    show_resolutions(pv)
    line("  写项=%s（被阻止的动作不能借时钟取得可提交资格）"
         % json.dumps(pv["state_proposal"]["changes"], ensure_ascii=False))
    pv = prepare(core, sid, [{"id": "m2", "operation": "move",
                              "target_ids": ["tavern"], "object_id": None}], "trace-back")
    commit(core, sid, pv, "trace-back")
    pv = prepare(core, sid, [{"id": "i1", "operation": "inspect", "target_ids": [],
                              "object_id": "cellar_key", "mode": "attempt",
                              "kind": "inspect"}], "trace-peek")
    line("  在酒馆观察旧井钥匙 prepare=%s" % pv["status"])
    show_resolutions(pv)
    pv = prepare(core, sid, [{"id": "i2", "operation": "inspect", "target_ids": [],
                              "object_id": "cellar_door", "mode": "attempt",
                              "kind": "inspect"}], "trace-look")
    line("  就地观察地窖门 prepare=%s" % pv["status"])
    rec = commit(core, sid, pv, "trace-look")
    line("  观察回执 knowledge_gained=%s"
         % json.dumps(rec["knowledge_gained"], ensure_ascii=False))
    line("  双方知识：player=%s / lia=%s"
         % ([e["entry_id"] for e in core.knowledge(sid, "player")["entries"]],
            [e["entry_id"] for e in core.knowledge(sid, "lia")["entries"]]))

    # ------------------------------------------------------------ ③ 声明
    rule("③ 反例：「我已经把钥匙给你了」只是声明")
    facts_before = copy.deepcopy(world_of(core, sid)["facts"])
    pv = prepare(core, sid, [{"id": "a1", "operation": "communicate",
                              "target_ids": ["lia"], "object_id": None,
                              "mode": "attempt", "kind": "claim",
                              "content": "我已经把钥匙给你了",
                              "evidence": "我已经把钥匙给你了"}], "trace-claim")
    line("  prepare=%s" % pv["status"])
    show_changes(pv)
    rec = commit(core, sid, pv, "trace-claim")
    w = world_of(core, sid)
    line("  声明后：key.owner=%s  door.locked=%s  door.open=%s  新增客观 facts=%s"
         % (w["objects"]["cellar_key"]["owner"], w["objects"]["cellar_door"]["locked"],
            w["objects"]["cellar_door"]["open"],
            len(w["facts"]) - len(facts_before)))
    line("  回合记录全文=%s" % json.dumps(w["turns"], ensure_ascii=False))
    line("  回合记录里是否出现声明原话：%s"
         % ("我已经把钥匙给你了" in json.dumps(w["turns"], ensure_ascii=False)))
    line("  回执是否携带声明内容：%s"
         % (rec["knowledge_gained"][0]["entry"]["content"] if rec["knowledge_gained"] else None))
    line("  双方 knowledge 的 statement 条目：player=%s"
         % json.dumps([e for e in core.knowledge(sid, "player")["entries"]
                       if e["kind"] == "statement"], ensure_ascii=False))
    line("  莉亚侧 statement（同样是 asserted_by，非客观真相）：%s"
         % json.dumps([e for e in core.knowledge(sid, "lia")["entries"]
                       if e["kind"] == "statement"], ensure_ascii=False))

    rule("④ 重复提交与重复询问")
    tick_before = world_of(core, sid)["turn_tick"]
    turns_before = len(world_of(core, sid)["turns"])
    replay = core.commit({"session_id": sid, "event_id": "trace-claim",
                          "analysis_id": rec["analysis_id"],
                          "expected_versions": rec["base_versions"]})
    line("  同一 event 重放 replayed=%s tick=%s->%s turns=%s->%s"
         % (replay["replayed"], tick_before, world_of(core, sid)["turn_tick"],
            turns_before, len(world_of(core, sid)["turns"])))
    pv = prepare(core, sid, [{"id": "a1", "operation": "communicate",
                              "target_ids": ["lia"], "object_id": "cellar_key",
                              "mode": "attempt", "kind": "question",
                              "content": "再说一次钥匙在哪",
                              "evidence": "再说一次钥匙在哪"}], "trace-ask-again")
    rec2 = commit(core, sid, pv, "trace-ask-again")
    line("  重复询问已知线索：status=%s tick=%s knowledge_gained=%s"
         % (rec2["status"], world_of(core, sid)["turn_tick"],
            json.dumps(rec2["knowledge_gained"], ensure_ascii=False)))
    line("  玩家知识未被重复写入：%s"
         % json.dumps(core.knowledge(sid, "player")["entries"], ensure_ascii=False))

    rule("边界：本轮只做 communicate(question/claim/表态) 与 inspect 的**服务端规则链**")
    line("  · 不接受玩家/模型自报难度、delta、outcome（注入即 422）；")
    line("  · attack 仍硬短路 UNSUPPORTED_OPERATION（六档对抗属 P2-B2b）；")
    line("  · 不接 Laya、云端语义解释与叙事；解释器与协议/桥/HTTP 未改。")

    text = "\n".join(OUT) + "\n"
    out_dir = Path(__file__).resolve().parent.parent / "_diag"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ("p2b2a_communicate_trace_%s.txt" % time.strftime("%Y%m%d_%H%M%S"))
    out.write_text(text, encoding="utf-8")
    print("trace_file=%s" % out)
    ok = (world_of(core, sid)["objects"]["cellar_key"]["owner"] is None
          and "我已经把钥匙给你了" not in json.dumps(world_of(core, sid)["turns"],
                                                    ensure_ascii=False)
          and replay.get("replayed") is True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
