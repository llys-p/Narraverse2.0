"""P2-B2b readable trace：单一非致命对抗（attack / kind=challenge）六档 + 贡献解释。

零模型、零云端、零 HTTP、零 Laya；跑一条成功、一次部分成功、一次失败与一次硬阻止，
把「贡献项 → Canonical Outcome → 预览/提交 → 下一轮状态」逐行打出来，末尾补注入与重放。

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p2b2b_contest_trace.py`
"""
import copy
import json
import sys
import time
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_delivery_interpreter as I
from laya_delivery_core import WORLD, DeliveryCore
from laya_state_protocol import _ProtoError

OUT = []


def line(text=""):
    OUT.append(text)
    print(text)


def rule(title):
    line("")
    line("─" * 78)
    line(title)
    line("─" * 78)


def reset(sid):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P)
    core.ensure_scene(sid)
    return core, P


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


def atk(aid, target="lia", kind="challenge", mode="attempt"):
    return {"id": aid, "operation": "attack", "target_ids": [target],
            "object_id": None, "mode": mode, "kind": kind, "content": "",
            "evidence": ""}


def fake(payload):
    """固定返回的假云端 caller（零云端）。"""
    raw = json.dumps(payload, ensure_ascii=False)
    return lambda system, user: (raw, None)


def set_strength(sid, value):
    B._ACTOR_STATE[(sid, "player")]["interaction"]["stats"]["strength"] = value


def set_energy(sid, value):
    B._ACTOR_STATE[(sid, "player")]["interaction"]["energy"] = value


def show_state(core, sid, tag):
    p = core.state(sid)["states"]["player"]["interaction"]
    l = core.state(sid)["states"]["lia"]["interaction"]
    w = world_of(core, sid)
    line("    %-6s player(energy=%s bp=%s)  lia(bp=%s)  tick=%s  turns=%d"
         % (tag, p["energy"], p["balance_pressure"],
            l["balance_pressure"], w["turn_tick"], len(w["turns"])))


def show_contrib(r):
    c = r["check"].get("contribution")
    if not c:
        line("    贡献拆解：无（硬前提未通过，不进公式）")
        return
    line("    贡献项：potency(strength)=%s  target_defense=%s  固定场景阻力=%s"
         % (c["potency_strength"], c["target_defense"], c["base_resistance"]))
    line("            ⇒ difficulty=%s  margin=%s  ⇒ degree=%s   （规则版本 %s）"
         % (c["difficulty"], c["margin"], c["degree"], c["rule_version"]))


def show_resolutions(pv):
    for r in pv["outcome"]["resolutions"]:
        line("    %-4s %-7s execution=%-9s degree=%-18s reasons=%s" % (
            r["action_id"], r["operation"], r["execution_status"], r["degree"],
            ",".join(r["check"]["reasons"]) or "-"))
        line("         achieved=%s" % r["achieved"])
        if r["costs"]:
            line("         costs=%s" % json.dumps(r["costs"], ensure_ascii=False))
        if r["complications"]:
            line("         complications=%s"
                 % json.dumps(r["complications"], ensure_ascii=False))
        if r["opportunities"]:
            line("         opportunities=%s（下一轮建议，不自动执行）"
                 % json.dumps(r["opportunities"], ensure_ascii=False))


def show_changes(pv):
    for ch in pv["state_proposal"]["changes"]:
        line("    %-7s %-38s %s -> %s" % (
            ch["entity_id"], ch["path"], _short(ch["before"]), _short(ch["after"])))


def _short(value):
    text = json.dumps(value, ensure_ascii=False)
    return text if len(text) <= 40 else text[:37] + "…"


def scenario(title, sid, strength, energy=10):
    core, P = reset(sid)
    set_strength(sid, strength)
    set_energy(sid, energy)
    rule(title)
    line("  服务端事实：player.strength=%s  player.energy=%s  lia.defense=%s  "
         "lia.bp=0  固定阻力=3" % (strength, energy, 2))
    return core, P


def main():
    ok = [True]

    # ------------------------------------------------------------ ① 成功
    core, P = scenario("① 成功档（margin 1 → success）：strength=6，第一轮", "b2b-trace-ok", 6)
    show_state(core, "b2b-trace-ok", "初始")
    pv = prepare(core, "b2b-trace-ok", [atk("a1")], "trace-ok-1")
    line("  prepare=%s can_commit=%s reason=%s"
         % (pv["status"], pv["can_commit"], pv["reason_codes"]))
    show_resolutions(pv)
    show_contrib(pv["outcome"]["resolutions"][0])
    line("  预览写项：")
    show_changes(pv)
    rec = commit(core, "b2b-trace-ok", pv, "trace-ok-1")
    line("  Canonical Outcome：result=%s degree=%s facts=%s"
         % (rec["outcome"]["result"], rec["outcome"]["degree"],
            json.dumps(rec["outcome"]["facts_created"], ensure_ascii=False)))
    line("  公开回合描述符（world.turns 末条 acts）：%s"
         % json.dumps(rec["acts"], ensure_ascii=False))
    show_state(core, "b2b-trace-ok", "提交后")
    ok[0] &= rec["outcome"]["degree"] == "success" and rec["outcome"]["result"] == "achieved"

    line("")
    line("  第二轮（同一会话，目标已失衡 2 → 继续施压，验证累计与截顶）：")
    pv2 = prepare(core, "b2b-trace-ok", [atk("a1")], "trace-ok-2")
    rec2 = commit(core, "b2b-trace-ok", pv2, "trace-ok-2")
    line("  Canonical Outcome：result=%s degree=%s"
         % (rec2["outcome"]["result"], rec2["outcome"]["degree"]))
    show_state(core, "b2b-trace-ok", "第二轮后")
    ok[0] &= core.state("b2b-trace-ok")["states"]["lia"]["interaction"]["balance_pressure"] == 4

    # ------------------------------------------------------------ ② 部分成功
    core, P = scenario("② 部分成功档（margin 0 → partial_success）：strength=5",
                       "b2b-trace-part", 5)
    pv = prepare(core, "b2b-trace-part", [atk("a1")], "trace-part-1")
    line("  prepare=%s reason=%s" % (pv["status"], pv["reason_codes"]))
    show_resolutions(pv)
    show_contrib(pv["outcome"]["resolutions"][0])
    line("  预览写项（只发布实际做到的变化）：")
    show_changes(pv)
    rec = commit(core, "b2b-trace-part", pv, "trace-part-1")
    line("  Canonical Outcome：result=%s degree=%s"
         % (rec["outcome"]["result"], rec["outcome"]["degree"]))
    show_state(core, "b2b-trace-part", "提交后")
    ok[0] &= rec["outcome"]["result"] == "partial_success"

    # ------------------------------------------------------------ ③ 失败
    core, P = scenario("③ 失败档（margin -4 → failure）：strength=1", "b2b-trace-fail", 1)
    pv = prepare(core, "b2b-trace-fail", [atk("a1")], "trace-fail-1")
    line("  prepare=%s reason=%s" % (pv["status"], pv["reason_codes"]))
    show_resolutions(pv)
    show_contrib(pv["outcome"]["resolutions"][0])
    line("  预览写项（失败仍扣资源、仍是一次真实回合；目标不受影响）：")
    show_changes(pv)
    rec = commit(core, "b2b-trace-fail", pv, "trace-fail-1")
    line("  Canonical Outcome：result=%s degree=%s"
         % (rec["outcome"]["result"], rec["outcome"]["degree"]))
    show_state(core, "b2b-trace-fail", "提交后")
    ok[0] &= (rec["outcome"]["result"] == "failed"
              and core.state("b2b-trace-fail")["states"]["lia"]["interaction"]["balance_pressure"] == 0)

    # ------------------------------------------------------------ ④ 硬阻止
    core, P = scenario("④ 硬阻止（energy=1 < 2）：不进公式、degree=null、不扣资源",
                       "b2b-trace-block", 5, energy=1)
    e0 = core.state("b2b-trace-block")["states"]["player"]["interaction"]["energy"]
    pv = prepare(core, "b2b-trace-block", [atk("a1")], "trace-block-1")
    line("  prepare=%s can_commit=%s reason=%s"
         % (pv["status"], pv["can_commit"], pv["reason_codes"]))
    show_resolutions(pv)
    show_contrib(pv["outcome"]["resolutions"][0])
    line("  预览写项：%s（无写项 ⇒ 不可提交）"
         % json.dumps(pv["state_proposal"]["changes"], ensure_ascii=False))
    show_state(core, "b2b-trace-block", "阻止后")
    ok[0] &= (pv["status"] == "blocked"
              and core.state("b2b-trace-block")["states"]["player"]["interaction"]["energy"] == e0)

    # ------------------------------------------------------------ ⑤ 注入与重放
    core, P = scenario("⑤ 权威边界：注入难度/档位 → 422；同 event 重放幂等；发布异常全回退",
                       "b2b-trace-guard", 6)
    bad = atk("a1")
    bad["difficulty"] = 1
    try:
        prepare(core, "b2b-trace-guard", [bad], "trace-inj")
        line("  注入 difficulty：未被拒绝 ❌")
        ok[0] = False
    except _ProtoError as e:
        line("  注入 difficulty → %s %s" % (e.code, (e.message or "")[:60]))
    bad2 = atk("a1")
    bad2["degree"] = "exceptional_success"
    try:
        prepare(core, "b2b-trace-guard", [bad2], "trace-inj2")
        line("  注入 degree：未被拒绝 ❌")
        ok[0] = False
    except _ProtoError as e:
        line("  注入 degree → %s %s" % (e.code, (e.message or "")[:60]))

    pv = prepare(core, "b2b-trace-guard", [atk("a1")], "trace-rep")
    r1 = commit(core, "b2b-trace-guard", pv, "trace-rep")
    snapshot = copy.deepcopy(core.state("b2b-trace-guard"))
    r2 = commit(core, "b2b-trace-guard", pv, "trace-rep")
    line("  同 event 重放：replayed=%s  状态未变=%s"
         % (r2.get("replayed"), core.state("b2b-trace-guard") == snapshot))
    ok[0] &= r2.get("replayed") is True and core.state("b2b-trace-guard") == snapshot

    pv = prepare(core, "b2b-trace-guard", [atk("a1")], "trace-roll")
    before = copy.deepcopy(B._ACTOR_STATE)
    with mock.patch.object(B, "_STATE_TRACE", _Boom()):
        try:
            commit(core, "b2b-trace-guard", pv, "trace-roll")
            line("  发布异常：未回退 ❌")
            ok[0] = False
        except _ProtoError as e:
            line("  发布异常 → %s（%s）" % (e.code, (e.message or "")[:48]))
    line("  无半提交：权威桶完全回退=%s" % (B._ACTOR_STATE == before))
    ok[0] &= B._ACTOR_STATE == before

    # ------------------------------------------------------------ ⑥ 解释器接线
    core, P = scenario("⑥ 真实消费者链（固定响应、零云端）：原话「我推搡莉亚」→ challenge → Prepare → Commit",
                       "b2b-trace-wire", 5)
    line("  解释器版本：interpreter=%s prompt=%s" % (I.INTERPRETER_VERSION, I.PROMPT_VERSION))
    msg = "我推搡莉亚"
    res = I.interpret_turn(core, "b2b-trace-wire", msg, event_id="trace-wire",
                           caller=fake({"actions": [{
                               "kind": "challenge", "operation": "attack",
                               "targets": ["莉亚"], "object": None, "mode": "attempt",
                               "evidence": [msg]}], "ambiguities": []}))
    it = res["interpretation"]
    line("  解释：status=%s caller=%s（未用云端）coercions=%s"
         % (it["status"], it["source"]["caller"], it["coercions"]))
    a = it["actions"][0]
    line("    action：operation=%s kind=%s target_ids=%s object_id=%s"
         % (a["operation"], a["kind"], a["target_ids"], a["object_id"]))
    line("    Prepare 请求：actor_id=%s actions=%d"
         % (res["prepare_request"]["actor_id"], len(res["prepare_request"]["actions"])))
    pv = core.prepare_structured(res["prepare_request"])
    line("  prepare=%s can_commit=%s reason=%s"
         % (pv["status"], pv["can_commit"], pv["reason_codes"]))
    show_resolutions(pv)
    show_contrib(pv["outcome"]["resolutions"][0])
    rec = commit(core, "b2b-trace-wire", pv, "trace-wire")
    line("  Canonical Outcome：result=%s degree=%s"
         % (rec["outcome"]["result"], rec["outcome"]["degree"]))
    show_state(core, "b2b-trace-wire", "提交后")
    line("  下一轮读到：player.energy 10→8、lia.balance_pressure 0→1（partial_success 增量 1）")
    ok[0] &= (rec["status"] == "committed"
              and core.state("b2b-trace-wire")["states"]["player"]["interaction"]["energy"] == 8
              and core.state("b2b-trace-wire")["states"]["lia"]["interaction"]["balance_pressure"] == 1)

    line("")
    core2, _ = scenario("反例① violence：如实解释 → 核心 UNSUPPORTED_OPERATION",
                        "b2b-trace-wire-v", 5)
    res_v = I.interpret_turn(core2, "b2b-trace-wire-v", "我一拳打在莉亚脸上", event_id="tw-v",
                             caller=fake({"actions": [{
                                 "kind": "violence", "operation": "attack",
                                 "targets": ["莉亚"], "object": None, "mode": "attempt",
                                 "evidence": ["我一拳打在莉亚脸上"]}], "ambiguities": []}))
    av = res_v["interpretation"]["actions"][0]
    line("  解释：operation=%s kind=%s（未被改写成 challenge）" % (av["operation"], av["kind"]))
    try:
        core2.prepare_structured(res_v["prepare_request"])
        line("  核心未拒绝 ❌")
        ok[0] = False
    except _ProtoError as e:
        line("  Prepare → %s %s" % (e.code, (e.message or "")[:70]))
    show_state(core2, "b2b-trace-wire-v", "被拒后")
    ok[0] &= (core2.state("b2b-trace-wire-v")["states"]["player"]["interaction"]["energy"] == 10
              and core2.state("b2b-trace-wire-v")["states"]["lia"]["interaction"]["balance_pressure"] == 0)

    line("")
    core3, _ = scenario("反例② 带物品 attack：核心 UNSUPPORTED_OPERATION、状态零变化",
                        "b2b-trace-wire-i", 5)
    res_i = I.interpret_turn(core3, "b2b-trace-wire-i", "我拿着徽章推搡莉亚", event_id="tw-i",
                             caller=fake({"actions": [{
                                 "kind": "challenge", "operation": "attack",
                                 "targets": ["莉亚"], "object": "徽章", "mode": "attempt",
                                 "evidence": ["我拿着徽章推搡莉亚"]}], "ambiguities": []}))
    ai = res_i["interpretation"]["actions"][0]
    line("  解释：operation=%s kind=%s object_id=%s"
         % (ai["operation"], ai["kind"], ai["object_id"]))
    try:
        core3.prepare_structured(res_i["prepare_request"])
        line("  核心未拒绝 ❌")
        ok[0] = False
    except _ProtoError as e:
        line("  Prepare → %s %s" % (e.code, (e.message or "")[:70]))
    show_state(core3, "b2b-trace-wire-i", "被拒后")
    ok[0] &= (core3.state("b2b-trace-wire-i")["states"]["player"]["interaction"]["energy"] == 10
              and core3.state("b2b-trace-wire-i")["states"]["lia"]["interaction"]["balance_pressure"] == 0)

    line("")
    line("边界：本轮只做无模型的服务端规则链；不接 Laya、云端语义解释与叙事；"
         "HTTP/页面/冻结资产未改；回执恒 rules_only。")

    text = "\n".join(OUT) + "\n"
    out_dir = Path(__file__).resolve().parent.parent / "_diag"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / ("p2b2b_contest_trace_%s.txt" % time.strftime("%Y%m%d_%H%M%S"))
    out.write_text(text, encoding="utf-8")
    print("trace_file=%s" % out)
    return 0 if ok[0] else 1


class _Boom(dict):
    def setdefault(self, key, default=None):
        raise RuntimeError("injected publish failure")


if __name__ == "__main__":
    sys.exit(main())
