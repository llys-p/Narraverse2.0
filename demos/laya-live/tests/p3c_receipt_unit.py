"""P3-C · DeliveryCore 回执信息表达 · 零模型定向检查（零模型、零 Laya 权重、零云端）。

覆盖《P3-C 回执信息表达》：
  C1  auxiliary 信号作为**精简参考**出现在候选与回执（may_write=false），绝不进 State Transition 写项；
      Prepare/Commit 不因 auxiliary 改变状态。
  C2  `rules_only=true` 时的 **Evidence 缺席原因**按实际阶段区分：未接入 Laya / 无可评估动作 /
      冻结译文缺失 / 引擎 fallback / 档案不可用 / 无 active 可写信号。
  C3  回执不含 Provider 原始响应字段（signal_values / raw_deltas_all_signals 等）与私有知识。
  C4  有真实写项时 `evidence_absent_reason=None`、`rules_only=false`（不误导为「有 Evidence 却缺席」）。

用固定响应 + mock 身份（不加载 Laya、不发真实推理）。真实小样见 `_diag/p3b_real_probe.py`。

★ 运行环境：Windows 控制台默认 GBK 编不出 ✅，请用
  `PYTHONIOENCODING=utf-8 python tests/p3c_receipt_unit.py`
"""
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B
import laya_evidence as EV
from laya_delivery_core import WORLD, DeliveryCore

FAIL = []
N = [0]


def chk(tag, ok, detail=""):
    N[0] += 1
    print("  %s [%s] %s" % ("✅" if ok else "❌", tag, detail))
    if not ok:
        FAIL.append(tag)


def cap_ident():
    """固定 mock 身份（避免依赖模型目录/真实档案）。"""
    return {"checkpoint": "typed-decisions", "profile_id": "fp_t",
            "matched": True, "fresh": True,
            "profile_sha256": "fakesha", "engine_model": "typed-decisions"}


def fresh(sid, provider=None):
    B.reset_actor_state()
    B.reset_history()
    B._PENDING.clear()
    P = B.PROTOCOL
    with P.lock:
        P._events.clear()
        P._buckets.clear()
        P._analyses.clear()
        P._inflight.clear()
    core = DeliveryCore(B, protocol=P, evidence_provider=provider,
                        capability_identity=cap_ident)
    core.ensure_scene(sid)
    return core, P


def doubt(core, sid):
    return core.state(sid)["states"]["lia"]["relationship"]["doubt"]


def ask(aid="a1", content="今晚人多吗？"):
    return {"id": aid, "operation": "communicate", "target_ids": ["lia"],
            "object_id": None, "mode": "attempt", "kind": "question",
            "content": content, "evidence": content}


def look(aid="a1"):
    """非 question 的 attempted 动作（无可评估 Evidence 目标）。"""
    return {"id": aid, "operation": "inspect", "target_ids": [], "object_id": "cellar_door",
            "mode": "attempt", "kind": "inspect", "content": "", "evidence": ""}


def prep(core, sid, actions, ev="ev1"):
    return core.prepare_structured({"session_id": sid, "event_id": ev, "actor_id": "player",
                                    "expected_versions": core.state(sid)["versions"],
                                    "actions": actions})


def commit(core, sid, pv, ev="ev1"):
    return core.commit({"session_id": sid, "event_id": ev,
                        "analysis_id": pv["analysis_id"],
                        "expected_versions": pv["base_versions"]})


def real_result(*, engine="laya", matched=True, fresh=True, delta=3.0, status="active",
                role="state_shift", target="relationship.doubt", may_write=True,
                auxiliaries=None):
    """构造 fake analyze_core 返回结构。"""
    proposal = {
        "profile": {"checkpoint": "typed-decisions", "profile_id": "fp_t",
                    "matched": matched, "fresh": fresh,
                    "problems": [] if (matched and fresh) else ["x"]},
        "delta": ([{"source_signal": "doubt_shift", "status": status, "role": role,
                    "target": target, "delta": delta, "checkpoint": "typed-decisions",
                    "profile_id": "fp_t"}] if status == "active" else []),
        "auxiliary": list(auxiliaries or []),
        "ignored_signals": [],
    }
    return {"engine": engine, "state_proposal": proposal,
            "capability_summary": {"state_writable": ["doubt_shift"] if may_write else []},
            "signal_values": {"doubt": 0.6}}


def provider_with(result, xlate=lambda zh: "Are there many people tonight?"):
    return EV.make_real_evidence_provider(infer=lambda *a: result, xlate_lookup=xlate)


AUX = [{"source_signal": "trust_shift", "role": "state_shift", "delta_if_enabled": 0.7},
       {"source_signal": "alert_shift", "role": "state_shift", "delta_if_enabled": 0.01}]


# ------------------------------------------------------------------ C1 auxiliary 可读但不写
def test_auxiliary_readable_but_not_written():
    core, P = fresh("p3c-aux", provider_with(real_result(status="auxiliary", auxiliaries=AUX)))
    before = doubt(core, "p3c-aux")
    pv = prep(core, "p3c-aux", [ask()])
    ev = pv["laya_evidence"][0]
    aux_signals = [s for s in ev["signals"] if s["status"] == "auxiliary"]
    chk("C1-① auxiliary 作为精简参考出现在 Evidence",
        len(aux_signals) == 2 and {s["signal"] for s in aux_signals} == {"trust_shift", "alert_shift"},
        str(ev["signals"]))
    chk("C1-② auxiliary 全部 may_write_state=false",
        all(s["may_write_state"] is False for s in aux_signals), "")
    chk("C1-③ auxiliary 不进 State Transition 写项（无 relationship.doubt 写项、rules_only=true）",
        pv["rules_only"] is True
        and not any(c["path"] == "relationship.doubt" for c in pv["state_proposal"]["changes"]),
        str(pv["state_proposal"]["changes"]))
    chk("C1-④ 缺席原因=no_active_writable_signal",
        pv["evidence_absent_reason"] == EV.ABSENT_NO_ACTIVE_WRITABLE,
        str(pv["evidence_absent_reason"]))
    chk("C1-⑤ Prepare 零游戏写入", doubt(core, "p3c-aux") == before, "")
    rec = commit(core, "p3c-aux", pv)
    chk("C1-⑥ Commit 后 doubt 不变（auxiliary 未写状态）",
        rec["status"] == "committed" and doubt(core, "p3c-aux") == before,
        "doubt=%s" % doubt(core, "p3c-aux"))
    chk("C1-⑦ 回执同样带 auxiliary 与缺席原因、rules_only=true",
        rec["rules_only"] is True
        and rec["evidence_absent_reason"] == EV.ABSENT_NO_ACTIVE_WRITABLE
        and any(s["status"] == "auxiliary" for s in rec["laya_evidence"][0]["signals"]), "")
    # auxiliary 不参与写项重算：直接验证 entries_to_changes 不产生写项
    changes = EV.entries_to_changes(core, core.state("p3c-aux")["states"],
                                    "player", pv["laya_evidence"])
    chk("C1-⑧ entries_to_changes 对纯 auxiliary 不产生写项", changes == [], str(changes))


# ------------------------------------------------------------------ C2 各缺席原因
def test_absent_reasons():
    # 未接入 Laya（无 Provider）
    core, P = fresh("p3c-nolaya", provider=None)
    pv = prep(core, "p3c-nolaya", [ask()])
    chk("C2-① 无 Provider → absent=laya_not_invoked、laya_evidence 空",
        pv["evidence_absent_reason"] == EV.ABSENT_LAYA_NOT_INVOKED and pv["laya_evidence"] == [],
        str(pv["evidence_absent_reason"]))

    # 无可评估动作（本轮无 communicate/question）
    core, P = fresh("p3c-noact", provider_with(real_result()))
    pv = prep(core, "p3c-noact", [look()])
    chk("C2-② 无 question 动作 → absent=no_evaluable_action",
        pv["evidence_absent_reason"] == EV.ABSENT_NO_EVALUABLE_ACTION,
        str(pv["evidence_absent_reason"]))

    # 冻结译文缺失（未调用 Laya）
    core, P = fresh("p3c-xlate", provider_with(real_result(), xlate=lambda zh: None))
    pv = prep(core, "p3c-xlate", [ask()])
    chk("C2-③ 冻结译文缺失 → absent=translation_missing、未调用 Laya",
        pv["evidence_absent_reason"] == EV.ABSENT_TRANSLATION_MISSING
        and pv["laya_evidence"] == [], str(pv["evidence_absent_reason"]))

    # 引擎 fallback
    core, P = fresh("p3c-fb", provider_with(real_result(engine="fallback")))
    pv = prep(core, "p3c-fb", [ask()])
    chk("C2-④ 引擎 fallback → absent=engine_fallback",
        pv["evidence_absent_reason"] == EV.ABSENT_ENGINE_FALLBACK, str(pv["evidence_absent_reason"]))

    # 档案不可用
    core, P = fresh("p3c-cap", provider_with(real_result(matched=False)))
    pv = prep(core, "p3c-cap", [ask()])
    chk("C2-⑤ 档案不 matched → absent=capability_unavailable",
        pv["evidence_absent_reason"] == EV.ABSENT_CAPABILITY_UNAVAILABLE,
        str(pv["evidence_absent_reason"]))

    # 有信号但无 active 可写（纯 auxiliary）
    core, P = fresh("p3c-noact2", provider_with(real_result(status="auxiliary", auxiliaries=AUX)))
    pv = prep(core, "p3c-noact2", [ask()])
    chk("C2-⑥ 无 active 可写 → absent=no_active_writable_signal",
        pv["evidence_absent_reason"] == EV.ABSENT_NO_ACTIVE_WRITABLE,
        str(pv["evidence_absent_reason"]))

    # 模型未产出任何信号：也无 active
    core, P = fresh("p3c-none", provider_with(real_result(status="noop")))
    pv = prep(core, "p3c-none", [ask()])
    chk("C2-⑦ 模型无信号 → absent=no_active_writable_signal、evidence 空",
        pv["evidence_absent_reason"] == EV.ABSENT_NO_ACTIVE_WRITABLE and pv["laya_evidence"] == [],
        str(pv["evidence_absent_reason"]))

    chk("C2-⑧ 缺席原因取值都在白名单内",
        all(pv["evidence_absent_reason"] in EV.ABSENT_REASONS
            for pv in [prep(fresh("p3c-w1", provider_with(real_result(engine="fallback")))[0],
                            "p3c-w1", [ask()])]), "")


# ------------------------------------------------------------------ C3 回执无原始响应 / 私有知识
def test_receipt_no_raw_or_private():
    SENTINEL = "PRIVATE-SENTINEL-999"
    core, P = fresh("p3c-raw", provider_with(real_result(delta=2.0)))
    # 往 lia 私有知识塞哨兵
    B._ACTOR_STATE[("p3c-raw", "lia")]["interaction"]["knowledge"].append(
        {"entry_id": "sentinel", "kind": "clue", "content": SENTINEL})

    def infer_leaky(*a):
        r = real_result(delta=2.0)
        # 模拟 Provider 返回里带原始字段（不应透传）
        r["signal_values"] = {"sentinel": SENTINEL}
        r["raw_deltas_all_signals"] = [{"secret": SENTINEL}]
        r["state_doc"] = SENTINEL
        r["raw"] = {"leak": SENTINEL}
        return r

    core._evidence_provider = EV.make_real_evidence_provider(
        infer=infer_leaky, xlate_lookup=lambda zh: "Are there many people tonight?")
    pv = prep(core, "p3c-raw", [ask()])
    rec = commit(core, "p3c-raw", pv)
    blob = json.dumps(rec, ensure_ascii=False)
    chk("C3-① 回执不含私有知识 / Provider 原始字段哨兵",
        SENTINEL not in blob, "len=%d" % len(blob))
    ev = rec["laya_evidence"][0]
    chk("C3-② Evidence 条目只含白名单字段",
        set(ev.keys()) <= set(EV.EVIDENCE_FIELDS), str(sorted(ev.keys())))
    sig = ev["signals"][0]
    allowed = set(EV.PROVIDER_SIGNAL_WHITELIST) | {"may_write", "transition"}
    chk("C3-③ signal 只含白名单字段（无 Provider 附带字段）",
        set(sig.keys()) <= allowed, str(sorted(sig.keys())))
    chk("C3-④ 回执无 signal_values / raw_deltas_all_signals / state_doc 等原始键",
        not any(k in blob for k in ("raw_deltas_all_signals", "state_doc", '"raw"')), "")


# ------------------------------------------------------------------ C4 有真实写项时缺席原因为 None
def test_writable_round_has_no_absent_reason():
    core, P = fresh("p3c-write", provider_with(real_result(delta=3.0)))
    pv = prep(core, "p3c-write", [ask()])
    chk("C4-① 有真实写项：rules_only=false 且 absent_reason=None",
        pv["rules_only"] is False and pv["evidence_absent_reason"] is None,
        "rules_only=%s absent=%s" % (pv["rules_only"], pv["evidence_absent_reason"]))
    rec = commit(core, "p3c-write", pv)
    chk("C4-② 回执同上，且 doubt 真正写入",
        rec["evidence_absent_reason"] is None and doubt(core, "p3c-write") == 33.0,
        "doubt=%s" % doubt(core, "p3c-write"))


def test_active_evidence_deadzone_is_not_absent():
    core, P = fresh("p3c-deadzone", provider_with(real_result(delta=0.5)))
    pv = prep(core, "p3c-deadzone", [ask()])
    sig = pv["laya_evidence"][0]["signals"][0]
    chk("C4-③ active Evidence 被死区归零：rules_only=true，但 Evidence 并未缺席",
        pv["rules_only"] is True and pv["evidence_absent_reason"] is None
        and sig["transition"]["deadzone"]["applied"] is True, "")


def main():
    test_auxiliary_readable_but_not_written()
    test_absent_reasons()
    test_receipt_no_raw_or_private()
    test_writable_round_has_no_absent_reason()
    test_active_evidence_deadzone_is_not_absent()
    print("\nP3-C 回执信息表达零模型定向检查：%d 项，%d 失败" % (N[0], len(FAIL)))
    if FAIL:
        print("失败项：" + "、".join(FAIL))
        return 1
    print("全部通过（零模型、零 Laya 权重、零云端、零 HTTP）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
