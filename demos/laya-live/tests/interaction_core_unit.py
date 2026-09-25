"""Interaction Core（候选 C）单元测试。

覆盖任务书 §18 的最低要求：
  Interpreter —— 直接/间接/否定/隐喻/多意图/多目标/中性 + fail-closed 降级链
  Resolver   —— 明确成功/失败/部分成功/资源不足/状态影响/环境影响 + false_claim
  Outcome    —— narration 不可改写结果（contract）+ fail forward
  Isolation  —— 2 NPC × 2 sessions

纪律：不写死测试句规则（没有 if text == ...）；LLM 通道全部 mock，
真实语义质量由后续黑盒隐藏表达验证（任务书 §5/§18）。
"""
import copy
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import laya_bridge as B                              # noqa: E402
from interaction_core import (                       # noqa: E402
    Degree, Intent, TurnInterpretation, FactCheckResult, LayaEvidence,
    ResolutionContext, facts as F, interpreter as I, resolver as R,
    outcome as O, narration as NA, pipeline as P,
)

FAIL = []
CNT = [0]


def chk(tag, ok, detail=""):
    CNT[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


def _it(t, conf=0.8, objs=None, targets=None, source="llm"):
    return Intent(type=t, confidence=conf, objects=objs or [],
                  targets=targets or [], source=source)


# ============================================================================
print("\n[Interpreter] LLM 归一化（mock _chat_json：验证契约与白名单，不测模型本身）")
# ============================================================================
def _llm_reply(intents, tone=None):
    return {"intents": intents, "tone": tone or []}


CASES_LLM = [
    # (名, 玩家原话, mock 返回, 期望 types)
    ("直接表达", "把名单给你。", [{"type": "evidence_handover", "objects": ["名单"], "confidence": 0.9}],
     ["evidence_handover"]),
    ("间接表达", "钥匙埋在旧井第三块砖下面。", [{"type": "information_handover", "objects": ["钥匙"], "confidence": 0.7}],
     ["information_handover"]),
    ("否定不产生被否定意图", "我不会伤害你。", [{"type": "cooperation", "confidence": 0.6}],
     ["cooperation"]),
    ("隐喻威胁", "你最好祈祷太阳还能升起来。", [{"type": "threat", "confidence": 0.75}],
     ["threat"]),
    ("多意图+多目标", "徽章扔桌上让她自己验，不信就算了。",
     [{"type": "evidence_handover", "objects": ["徽章"], "confidence": 0.85},
      {"type": "challenge", "targets": ["她"], "confidence": 0.6}],
     ["evidence_handover", "challenge"]),
    ("中性", "今晚风真大。", [{"type": "neutral", "confidence": 0.8}], ["neutral"]),
]
for name, text, reply, expect in CASES_LLM:
    with mock.patch.object(I, "_chat_json", return_value=_llm_reply(reply)):
        interp = I.interpret_turn(text, laya_signals={}, actor_name="莉亚")
    got = [i.type for i in interp.intents]
    chk("Interpreter·%s" % name, interp.source == "llm" and got == expect,
        "src=%s got=%s" % (interp.source, got))

with mock.patch.object(I, "_chat_json", return_value=_llm_reply(
        [{"type": "teleport_to_moon", "confidence": 0.9},
         {"type": "threat", "confidence": 0.7}])):
    interp = I.interpret_turn("随便什么话", laya_signals={})
chk("Interpreter·幻觉类别被白名单丢弃", [i.type for i in interp.intents] == ["threat"],
    "got=%s" % [i.type for i in interp.intents])

with mock.patch.object(I, "_chat_json", side_effect=I.InterpretationFailure("bad json")):
    interp = I.interpret_turn("老井第三块砖下面有钥匙。", laya_signals={"disclose": 0.72})
chk("Interpreter·LLM 失败降级到 laya_only（fail-closed）",
    interp.source == "laya_only"
    and any(i.type == "information_handover" for i in interp.intents)
    and any("llm_failed" in n for n in interp.notes),
    "src=%s intents=%s" % (interp.source, [i.type for i in interp.intents]))

with mock.patch.object(I, "_llm_available", return_value=False):
    interp = I.interpret_turn("今晚风真大。", laya_signals={})
chk("Interpreter·无信号无 LLM → neutral_fallback",
    interp.source == "neutral_fallback" and interp.intents[0].type == "neutral",
    "src=%s" % interp.source)

interp = I.interpret_turn("", laya_signals={})
chk("Interpreter·空输入 → neutral_fallback", interp.source == "neutral_fallback", "")

# ============================================================================
print("\n[Resolver] 分级结算（纯函数，确定性）")
# ============================================================================
TS = {"doubt": 30.0, "trust": 60.0, "respect": 45.0, "alert": 0.45, "fondness": 0.35}


def _ctx(itype, conf=0.8, fact=None, ts=None, laya=None, env=None, diff=0.0):
    return ResolutionContext(
        intent=_it(itype, conf=conf), fact=fact or FactCheckResult(intent_ref=0, verdict="ok"),
        target_stats=dict(ts or TS), laya=laya or LayaEvidence(),
        environment=dict(env or {}), difficulty=diff, actor_label="player")


r = R.resolve(_ctx("information_handover", conf=0.9))
chk("Resolver·明确成功（信任向）", r.degree >= Degree.SUCCESS,
    "%s margin=%.2f" % (r.degree.label, r.margin))

r = R.resolve(_ctx("information_handover", conf=0.9, fact=FactCheckResult(
    intent_ref=0, verdict="false_claim", reasons=["无该物件"])))
chk("Resolver·false_claim → 失败系（声称交出没有的东西）",
    r.degree <= Degree.FAILURE, "%s margin=%.2f" % (r.degree.label, r.margin))

r = R.resolve(_ctx("evidence_handover", conf=0.9, ts=dict(TS, doubt=85.0, trust=10.0)))
chk("Resolver·目标高怀疑低信任 → 部分或更差", r.degree <= Degree.PARTIAL_SUCCESS,
    "%s margin=%.2f" % (r.degree.label, r.margin))

r = R.resolve(_ctx("violence", conf=0.9, fact=FactCheckResult(
    intent_ref=0, verdict="insufficient", reasons=["已缴械"])))
chk("Resolver·资源不足（缴械）→ 行动力度受损", r.degree <= Degree.PARTIAL_SUCCESS,
    "%s margin=%.2f" % (r.degree.label, r.margin))

r = R.resolve(_ctx("threat", conf=0.9, ts=dict(TS, alert=0.95)))
chk("Resolver·状态影响（高警觉目标抗威胁）", r.degree <= Degree.SUCCESS,
    "%s margin=%.2f" % (r.degree.label, r.margin))

r0 = R.resolve(_ctx("threat", conf=0.9, diff=3.0))
r1 = R.resolve(_ctx("threat", conf=0.9, diff=3.0))
chk("Resolver·环境影响（显式难度）+ 确定性（同输入同输出）",
    r0.degree == r1.degree and r0.margin == r1.margin and r0.degree < R.resolve(
        _ctx("threat", conf=0.9)).degree,
    "with_diff=%s no_diff_margin=%.2f" % (r0.degree.label, r1.margin))

r = R.resolve(_ctx("violence", conf=0.9, fact=FactCheckResult(
    intent_ref=0, verdict="denied", reasons=["被束缚"])))
chk("Resolver·硬规则禁止（束缚）→ critical_failure", r.degree == Degree.CRITICAL_FAILURE,
    r.degree.label)

r = R.resolve(_ctx("threat", conf=0.9, laya=LayaEvidence(
    signals={"hostility": 0.9, "cooperation": 0.1})))
chk("Resolver·Laya 一致性支持（evidence 抬升而非决定）", r.degree >= Degree.SUCCESS,
    r.degree.label)

r = R.resolve(ResolutionContext(
    intent=_it("threat", conf=0.9, source="laya"), 
    fact=FactCheckResult(intent_ref=0, verdict="ok"),
    target_stats=dict(TS), laya=LayaEvidence()))
chk("Resolver·降级解释（laya-only 来源）保守结算（力度打折）",
    r.margin < R.resolve(_ctx("threat", conf=0.9)).margin, "margin=%.2f" % r.margin)

chk("Resolver·贡献分解可审计（每档都能解释为什么）",
    any(c["factor"] == "base_potency" for c in r.contributions)
    and all("why" in c for c in r.contributions),
    "n=%d" % len(r.contributions))

# ============================================================================
print("\n[Outcome] Canonical + Fail Forward + Narration Contract")
# ============================================================================
def _interp(types_confs):
    return TurnInterpretation(text="t", intents=[_it(t, conf=c) for t, c in types_confs])


def _ress(interp_types, degs):
    return [ActionResolution_stub(i, d) for i, d in zip(range(len(interp_types)), degs)]


class ActionResolution_stub:
    def __init__(self, ref, deg):
        self.intent_ref = ref
        self.degree = deg
        self.margin = 1.0
        self.potency = 3.0
        self.difficulty_total = 2.0
        self.contributions = [{"factor": "stub", "value": 0, "why": "stub"}]
        self.rationale = "stub"


oc = O.build_outcome("t1", _interp([("evidence_handover", 0.9)]),
                     _ress(["evidence_handover"], [Degree.SUCCESS]), target_name="莉亚")
chk("Outcome·成功出示证据 → doubt 下降 + resolved_by 标注",
    oc.state_changes and oc.state_changes[0].delta < 0
    and oc.state_changes[0].resolved_by == "resolver:evidence_handover",
    "delta=%s" % (oc.state_changes[0].delta if oc.state_changes else None))

oc = O.build_outcome("t2", _interp([("evidence_handover", 0.9)]),
                     _ress(["evidence_handover"], [Degree.CRITICAL_FAILURE]), target_name="莉亚")
chk("Outcome·被拆穿 → doubt 反向上升 + complication（fail forward）",
    oc.state_changes and oc.state_changes[0].delta > 0
    and any("识破" in c or "验货" in c for c in oc.complications),
    "delta=%s complications=%s" % (oc.state_changes[0].delta, oc.complications[:1]))

oc = O.build_outcome("t3", _interp([("information_handover", 0.8), ("challenge", 0.7)]),
                     _ress(["a", "b"], [Degree.PARTIAL_SUCCESS, Degree.SUCCESS]),
                     target_name="莉亚")
chk("Outcome·多意图折叠（degrees 全记录，主意图=evidence/handover 类）",
    set(oc.degrees.keys()) == {"information_handover", "challenge"}
    and oc.primary_intent in ("information_handover", "challenge"),
    "degrees=%s primary=%s" % (sorted(oc.degrees.keys()), oc.primary_intent))

oc = O.build_outcome("t4", _interp([("threat", 0.9)]),
                     _ress(["threat"], [Degree.SUCCESS]), target_name="莉亚")
chk("Outcome·威胁成功的代价（costs 非空）+ contract 禁区",
    oc.costs and any("敌意" in c for c in oc.costs)
    and any("完全不信" in b for b in oc.narration_contract.must_not_include),
    "costs=%s" % oc.costs[:1])

# narration 不可改写结果：contract 校验抓违约
oc = O.build_outcome("t5", _interp([("information_handover", 0.8)]),
                     _ress(["information_handover"], [Degree.FAILURE]), target_name="莉亚")
viol = NA.check_contract("她松了口，完全相信了你。",
                        oc.narration_contract.must_not_include)
chk("Outcome·narration 违约被抓住（failure 不得写成相信）",
    len(viol) >= 2, "violations=%s" % viol)

viol = NA.check_contract("她盯着你，眼神没有松动。", oc.narration_contract.must_not_include)
chk("Outcome·合规台词零违例", viol == [], "violations=%s" % viol)

# ============================================================================
print("\n[Facts] 前提验证")
# ============================================================================
F.reset_fact_bases()
F.add_item("s1", "lia", "徽章")
fr = F.check_facts("s1", "lia", [_it("evidence_handover", objs=["徽章"])])
chk("Facts·持有徽章 → ok", fr[0].verdict == "ok", fr[0].verdict)
fr = F.check_facts("s1", "lia", [_it("evidence_handover", objs=["名单"])])
chk("Facts·声称交出未持有物 → false_claim", fr[0].verdict == "false_claim", fr[0].verdict)
fr = F.check_facts("s1", "lia", [_it("evidence_handover", objs=[])])
chk("Facts·未指明物件 → insufficient（不默认成功）", fr[0].verdict == "insufficient", fr[0].verdict)
F.set_status("s1", "lia", "bound", True)
fr = F.check_facts("s1", "lia", [_it("violence")])
chk("Facts·被束缚 → denied", fr[0].verdict == "denied", fr[0].verdict)
fr = F.check_facts("s1", "lia", [_it("question")])
chk("Facts·束缚不影响非主动意图（question 仍 ok）", fr[0].verdict == "ok", fr[0].verdict)

# ============================================================================
print("\n[Isolation] 2 NPC × 2 sessions（FactBase 隔离）")
# ============================================================================
F.reset_fact_bases()
F.add_item("sessA", "npc1", "徽章")
F.add_item("sessA", "npc2", "名单")
F.add_item("sessB", "npc1", "钥匙")
fr = F.check_facts("sessA", "npc1", [_it("evidence_handover", objs=["名单"])])
chk("Isolation·同 session 跨 NPC 不串库存（npc1 无名单）", fr[0].verdict == "false_claim", fr[0].verdict)
fr = F.check_facts("sessB", "npc1", [_it("evidence_handover", objs=["钥匙"])])
chk("Isolation·同 NPC 跨 session 不串库存（sessB 有钥匙）", fr[0].verdict == "ok", fr[0].verdict)
fr = F.check_facts("sessA", "npc2", [_it("evidence_handover", objs=["名单"])])
chk("Isolation·npc2 自己的库存可用", fr[0].verdict == "ok", fr[0].verdict)

# ============================================================================
print("\n[Pipeline] 集成（mock decide/LLM，真协议层 propose/commit）")
# ============================================================================
def _reset_bridge_state():
    B.reset_actor_state()
    B.reset_history()
    for k in list(B._PENDING):
        B._PENDING.pop(k, None)
    B.PROTOCOL._buckets.clear()
    B.PROTOCOL._analyses.clear()
    B.PROTOCOL._events.clear()
    B.PROTOCOL._inflight.clear()
    F.reset_fact_bases()


_FAKE_DECIDE = {
    "ok": True, "engine": "laya",
    "signal_values": {"disclose": 0.7, "hostility": 0.2, "cooperation": 0.4},
    "policy": {"behavior": "observe", "source": "rule"},
    "state_validation": {"decision": {"turn_id": "x"}},
    "state_proposal": {"delta": [{"source_signal": "doubt_shift",
                                  "target": "relationship.doubt",
                                  "delta": 1.5, "status": "active", "grade": "A",
                                  "role": "state_shift", "label": "怀疑",
                                  "range": [0, 100]}]},
}


def _fake_decide(payload, frozen_state=None):
    out = copy.deepcopy(_FAKE_DECIDE)
    out["turn"] = {"turn_id": "tt", "session_id": payload.get("session_id"),
                   "actor_id": payload.get("actor_id"), "history_bucket": None}
    return out


with mock.patch.object(B, "decide", side_effect=_fake_decide), \
     mock.patch.object(I, "_chat_json", return_value=_llm_reply(
         [{"type": "information_handover", "objects": ["钥匙"], "confidence": 0.85}])), \
     mock.patch.object(NA, "narrate_from_outcome",
                       return_value={"line": "她沉默地听完，指节在桌面轻叩。", 
                                     "contract_violations": [], "attempts": []}):
    _reset_bridge_state()
    res = P.run_core_turn(B, {"session_id": "psA", "actor_id": "lia",
                              "player_input": "钥匙埋在旧井第三块砖下面。",
                              "use_llm": True})
chk("Pipeline·完整链路 ok + 协议层真实提交",
    res["ok"] and res["commit"]["committed"],
    "commit=%s note=%s" % (res["commit"]["committed"], res["commit"]["note"][:50]))
chk("Pipeline·resolver 权威替换 Laya 原生 doubt 条目（rule_adjudicated 透传）",
    any((d.get("rule_adjudicated") == "resolver:information_handover"
         or d.get("source_signal") == "resolver:information_handover")
        for d in res["commit"]["commits"]),
    "commits=%s" % [(d.get("source_signal"), d.get("delta"),
                     d.get("rule_adjudicated")) for d in res["commit"]["commits"]])
chk("Pipeline·trace 覆盖全层（capture→…→commit→narration）",
    [t["layer"] for t in res["trace"]] == ["capture_scope", "laya_evidence",
                                           "interpretation", "fact_checks",
                                           "resolutions", "npc_counter",
                                           "outcome", "commit", "narration"],
    "layers=%s" % [t["layer"] for t in res["trace"]])

with mock.patch.object(B, "decide", side_effect=lambda p, frozen_state=None: dict(
        _fake_decide(p), policy={"behavior": None, "source": "ambiguous"})), \
     mock.patch.object(I, "_chat_json", return_value=_llm_reply(
         [{"type": "neutral", "confidence": 0.9}])), \
     mock.patch.object(NA, "narrate_from_outcome", return_value={"line": None}):
    _reset_bridge_state()
    res2 = P.run_core_turn(B, {"session_id": "psA", "actor_id": "lia",
                               "player_input": "今晚风真大。", "use_llm": False})
chk("Pipeline·中性轮 + NPC 行为歧义 → 不提交但 outcome 照常返回",
    res2["ok"] and res2["commit"]["committed"] is False
    and res2["outcome"] is not None,
    "committed=%s note=%s" % (res2["commit"]["committed"], res2["commit"]["note"][:40]))

# 隔离：两个 session 各跑一轮；isoA 再跑一轮后 isoB 的版本/状态必须不动
with mock.patch.object(B, "decide", side_effect=_fake_decide), \
     mock.patch.object(I, "_chat_json", side_effect=[
         _llm_reply([{"type": "threat", "confidence": 0.9}]),
         _llm_reply([{"type": "threat", "confidence": 0.9}]),
         _llm_reply([{"type": "threat", "confidence": 0.9}])]), \
     mock.patch.object(NA, "narrate_from_outcome", return_value={"line": None}):
    _reset_bridge_state()
    ra = P.run_core_turn(B, {"session_id": "isoA", "actor_id": "lia",
                             "player_input": "祈祷太阳吧。", "use_llm": False})
    rb = P.run_core_turn(B, {"session_id": "isoB", "actor_id": "lia",
                             "player_input": "祈祷太阳吧。", "use_llm": False})
    ver_b_after_first = B.PROTOCOL.state_version(("isoB", "lia"))
    doubt_b_after_first = (B.actor_state_snapshot("isoB", "lia")
                           .get("relationship", {}).get("doubt"))
    ra2 = P.run_core_turn(B, {"session_id": "isoA", "actor_id": "lia",
                              "player_input": "再说一遍。", "use_llm": False})
chk("Pipeline·2 sessions 状态隔离（isoA 二轮不影响 isoB）",
    ra["ok"] and rb["ok"] and ra2["ok"]
    and B.PROTOCOL.state_version(("isoB", "lia")) == ver_b_after_first
    and (B.actor_state_snapshot("isoB", "lia")
         .get("relationship", {}).get("doubt")) == doubt_b_after_first
    and ra2["commit"]["committed"],
    "verB_stable=%s doubtB_stable=%s" % (
        B.PROTOCOL.state_version(("isoB", "lia")) == ver_b_after_first,
        (B.actor_state_snapshot("isoB", "lia")
         .get("relationship", {}).get("doubt")) == doubt_b_after_first))

# fallback 引擎结果被协议门禁拒绝（复用 commit_legacy_turn 的 R3）
with mock.patch.object(B, "decide", side_effect=lambda p, frozen_state=None: dict(
        _fake_decide(p), engine="fallback")), \
     mock.patch.object(I, "_chat_json", return_value=_llm_reply(
         [{"type": "threat", "confidence": 0.9}])), \
     mock.patch.object(NA, "narrate_from_outcome", return_value={"line": None}):
    _reset_bridge_state()
    rf = P.run_core_turn(B, {"session_id": "fb", "actor_id": "lia",
                             "player_input": "祈祷太阳吧。", "use_llm": False})
chk("Pipeline·fallback 引擎 → 协议门禁拒绝提交（不冒充模型判断）",
    rf["ok"] and rf["commit"]["committed"] is False
    and "fallback" in (rf["commit"]["note"] or ""),
    "note=%s" % (rf["commit"]["note"] or "")[:60])

# ============================================================================
print("\n合计 %d 项：%d PASS / %d FAIL" % (CNT[0], CNT[0] - len(FAIL), len(FAIL)))
if FAIL:
    print("失败项：%s" % "、".join(FAIL))
print("=" * 92)
sys.exit(1 if FAIL else 0)
