"""Phase3-P2 验收（Task 8/9/10）。

用**可执行的断言**回答提示词里的验收问题 A–F，而不是只在报告里写一段话。
凡是「必须能说出是哪几条、为什么」的结论，这里都要求字段存在且非空 ——
因为「忽略了 3 个」和「忽略了哪 3 个、为什么」在验收上是两件不同的事。

用法：
    ./.venv-cuda/Scripts/python.exe tests/p2_acceptance.py
    ./.venv-cuda/Scripts/python.exe tests/p2_acceptance.py --json   # 额外落盘 tests/p2_acceptance.json

★ 本脚本**不跑模型批量推理**：只加载一次引擎做 2 次 decide，其余全部走单元级调用。
  跑一次约十秒级，可以随手重跑。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_root(start):
    d = start
    for _ in range(4):
        if os.path.exists(os.path.join(d, "laya_bridge.py")):
            return d
        d = os.path.dirname(d)
    raise SystemExit("找不到 laya_bridge.py；脚本必须在 laya-live/ 之内")


ROOT = _find_root(HERE)
sys.path.insert(0, ROOT)

import laya_bridge as B  # noqa: E402

PASS, FAIL, INFO, SKIP = [], [], [], []
RESULTS = {}


def ok(cond, label, detail=""):
    (PASS if cond else FAIL).append(label)
    print("  %s %s%s" % ("PASS" if cond else "FAIL", label, ("  ｜ " + detail) if detail else ""))
    return bool(cond)


def info(msg):
    INFO.append(msg)
    print("  · %s" % msg)


def skip(msg):
    SKIP.append(msg)
    print("  SKIP %s" % msg)


def head(t):
    print("\n" + "=" * 78 + "\n" + t + "\n" + "=" * 78)


def main():
    want_json = "--json" in sys.argv

    # ================================================================
    head("[Task 9] Signal Role 分层：15 个 signal 全覆盖，一个都不能少")
    # ================================================================
    names = B.all_signal_names()
    roles = B._signal_roles(strict=True)
    ok(len(names) == 15, "可定级 signal 共 15 个", "、".join(names))
    ok(roles is not None, "signals.roles 覆盖全部 signal（strict 通过）")
    role_of = {}
    if roles:
        role_of = dict((k, (v or {}).get("role")) for k, v in roles.items() if k in names)
        ok(all(role_of.get(n) in B._ROLE_NAMES for n in names),
           "每个 signal 的 role 都属于 {%s}" % "、".join(B._ROLE_NAMES))
        ok(all((roles.get(n) or {}).get("semantic_zh") for n in names),
           "每个 signal 都有语义描述（semantic_zh）")
        ok(all((roles.get(n) or {}).get("range") for n in names),
           "每个 signal 都标了取值范围")
        by_role = {}
        for n in names:
            by_role.setdefault(role_of.get(n), []).append(n)
        for r in B._ROLE_NAMES:
            info("%-21s %d 个：%s" % (r, len(by_role.get(r, [])), "、".join(by_role.get(r, []))))
        ok(set(role_of.get(n) for n in names) == set(B._ROLE_NAMES),
           "三个 role 都被用到（没有空层）")
    RESULTS["roles"] = role_of

    # ================================================================
    head("[Task 8] Capability Profile：从实验结果推导，且能自证来源")
    # ================================================================
    blob = B.load_capability_profiles(force=True)
    ok(bool(blob and blob.get("profiles")), "tests/capability_profiles.json 存在且含 profiles")
    if not blob:
        print("\n没有能力档案，后面的断言无法进行。先跑：laya_bridge.py capability")
        return 1
    profs = blob["profiles"]

    model = getattr(B.ENGINE, "model_name", None) or B.DEFAULT_MODEL_NAME
    prof, check = B.load_capability_profile(model)

    # A —— 当前跑的是哪个 checkpoint，且档案是否对得上
    head("[A] 当前在跑哪个 checkpoint？能力档案对得上吗？")
    info("运行中的检查点 = %s" % model)
    info("档案里的检查点 = %s ｜ profile_id = %s"
         % (check.get("checkpoint"), (check.get("profile_id") or "")[:16]))
    ok(check.get("matched"), "[A] 档案的 checkpoint 与运行中的一致")
    ok(prof is not None, "[A] 档案 fresh（输入侧四个哈希全部对得上）",
       "；".join(check.get("problems") or []) or "无问题")
    if check.get("code_changed"):
        info("code_changed=True（只提示不阻断）：代码在生成档案后被改过，"
             "判据在代码里，所以重新跑一次 capability 即可消除")
    RESULTS["A_checkpoint"] = {"running": model, "matched": check.get("matched"),
                               "fresh": check.get("fresh"),
                               "profile_id": check.get("profile_id"),
                               "code_changed": check.get("code_changed"),
                               "problems": check.get("problems")}

    # B —— 哪些 signal 各是什么状态
    head("[B] 哪些 signal 是 active / auxiliary / disabled / semantic_review？")
    if prof:
        sig = prof["signals"]
        got = dict((k, v.get("status")) for k, v in sig.items())
        ok(set(got.keys()) == set(names), "[B] 档案覆盖全部 15 个 signal")
        ok(all(s in B._STATUSES for s in got.values()),
           "[B] 所有 status 都属于 {%s}" % "、".join(B._STATUSES))
        cnt = dict((s, 0) for s in B._STATUSES)
        for s in got.values():
            cnt[s] += 1
        ok(sum(cnt.values()) == 15, "[B] status 分布合计 = 15", json.dumps(cnt, ensure_ascii=False))
        for st in B._STATUSES:
            grp = [n for n in names if got.get(n) == st]
            info("%-16s %d 个：%s" % (st, len(grp), "、".join(grp) or "（无）"))
        # 每个 status 都必须带非空理由（含 policy_override 的）
        ok(all(sig[n].get("status_reasons") for n in names),
           "[B] 每个 signal 的 status 都附了非空理由")
        ov = [n for n in names if sig[n].get("status_source") == "policy_override"]
        info("声明式覆盖（status_source=policy_override，可见、不伪装成推导）：%s"
             % ("、".join(ov) or "（无）"))
        ok(all(sig[n].get("status_source") in ("derived", "policy_override") for n in names),
           "[B] status_source 只有 derived / policy_override 两种")

        # role 与 status 正交：有 status=active 却不是 state_shift 的，不能写状态
        bad = [n for n in names if sig[n].get("status") == "active"
               and sig[n].get("may_write_state")]
        ok(all(sig[n].get("role") == "state_shift" for n in bad),
           "[B] 只有 role=state_shift 的 active 才会 may_write_state")
        RESULTS["B_status"] = {"counts": cnt,
                               "by_status": dict((s, [n for n in names if got.get(n) == s])
                                                 for s in B._STATUSES),
                               "override": ov,
                               "state_writable": prof and
                               [n for n in names if (prof["signals"][n] or {}).get("may_write_state")]}

        # 等级必须来自实验产物，不是手写
        ok(all(sig[n].get("grade_by_run") for n in names),
           "[B] 每个 signal 都记了逐次运行的 grade（可回溯到 tests/runs/）",
           "例如 trust_shift=%s" % (sig["trust_shift"].get("grade_by_run"),))
        ok(all((sig[n].get("grade_by_run") or [None])[0] is not None for n in names),
           "[B] 等级非空 —— 没有「凭印象写」的 signal")

    # ================================================================
    head("[C] 一个 signal 为什么能进 State Transition？（必须能追溯到实验结果）")
    # ================================================================
    ok(B.ENGINE.init() is not False, "[C] 引擎已初始化（Laya 或回退）")
    answers = dict((n, {"_value": 3.0}) for n in B.SHIFT_IDS)
    deltas, _attr = B.build_deltas(answers, B.CFG["questions"], B.CFG["actor"])
    vals = dict((n, 0.5) for n in B.all_signal_names()
                if n in ((B.CFG.get("signals") or {}).get("order") or []))
    sp, bt, sa = B.build_state_proposal(answers, deltas, vals, prof, check)

    ok(len(sp["delta"]) + len(sp["auxiliary"]) + len(sp["ignored_signals"]) == len(deltas),
       "[C] 每一条原始增量都被明确分类（active/auxiliary/ignored 三者之和 = 全部）",
       "%d + %d + %d = %d" % (len(sp["delta"]), len(sp["auxiliary"]),
                              len(sp["ignored_signals"]), len(deltas)))
    if prof:
        sig = prof["signals"]
        for d in sp["delta"]:
            n = d["source_signal"]
            ok(sig[n]["role"] == "state_shift" and sig[n]["status"] == "active"
               and sig[n]["grade"] == d["grade"],
               "[C] delta 的 %s 可追溯到「role=state_shift + status=active + grade=%s」"
               % (n, d["grade"]),
               "AUC 中位 %s ｜ 逐次 grade %s"
               % (sig[n]["metrics"]["auc_median"], sig[n]["grade_by_run"]))
        ok(all((d.get("reason") or []) and all(r for r in d["reason"]) for d in sp["auxiliary"]),
           "[C] 每个 auxiliary 都写清了「为什么只能当修正项」")
        ok(all((d.get("reason") or []) and all(r for r in d["reason"]) for d in sp["ignored_signals"]),
           "[C] 每个 blocked 的 signal 都写清了理由（不是只说「忽略了 N 个」）")
        ok(all(d.get("applied") is False for d in sp["auxiliary"]),
           "[C] auxiliary 在 P2 阶段一律 applied=false（比提示词更严：不产生数值效果）")
    RESULTS["C_proposal"] = {"n_delta": len(sp["delta"]), "n_aux": len(sp["auxiliary"]),
                             "n_ignored": len(sp["ignored_signals"]),
                             "delta_sources": [d["source_signal"] for d in sp["delta"]]}

    # ================================================================
    head("[D] 换 checkpoint 时，系统知道能力档案变了吗？")
    # ================================================================
    p_other, c_other = B.load_capability_profile("multilingual")
    ok(p_other is None, "[D] 未登记的检查点 → 拒绝使用档案（返回 None，不退回「全都可用」）")
    ok(bool(c_other.get("problems")), "[D] 拒绝时给出了原因", "；".join(c_other["problems"])[:110])
    sp_o, _, _ = B.build_state_proposal(answers, deltas, vals, p_other, c_other)
    ok(len(sp_o["delta"]) == 0, "[D] 档案不可用时一条状态增量都不产出")
    ok(sp_o["gate"]["can_commit_state"] is False, "[D] gate.can_commit_state = False")
    ok(all((d.get("reason") or []) for d in sp_o["ignored_signals"]),
       "[D] 被拦下的 signal 逐条给了理由（%d 条）" % len(sp_o["ignored_signals"]))

    # 哈希失配必须被识别出来（用内存注入模拟，不动磁盘文件）
    _orig = B._dataset_fingerprint
    try:
        B._dataset_fingerprint = lambda: dict(_orig(), sha="deadbeef" * 8)
        _, c_bad = B.load_capability_profile(model)
        ok(not c_bad["fresh"], "[D] 用例集变化 → 判为 stale（拒绝沿用旧档案）",
           "；".join(c_bad["problems"])[:100])
    finally:
        B._dataset_fingerprint = _orig
    _, c_ok = B.load_capability_profile(model)
    ok(c_ok["fresh"], "[D] 复原后重新判为 fresh（没有把 stale 状态粘住）")
    RESULTS["D_switch"] = {"unregistered": c_other.get("problems"),
                           "blocked_deltas": len(sp_o["delta"]),
                           "stale_detected": not c_bad["fresh"]}

    # ================================================================
    head("[E] Laya 的输出仍然只是 Proposal —— 它有没有直接写 Actor State？")
    # ================================================================
    ok(sp.get("is_proposal") is True, "[E] state_proposal.is_proposal = True")
    ok(sp.get("authority") == "none", "[E] state_proposal.authority = none（无写入权限）")
    ok(isinstance(sp.get("delta"), list) and isinstance(sp.get("auxiliary"), list),
       "[E] delta / auxiliary 都是并列的建议项，没有任何「已提交」语义")
    ok(not any(k in sp for k in ("committed", "applied_state", "actor_state", "write")),
       "[E] proposal 里不存在 committed / actor_state / write 这类字段")
    # 真值是否可能被就地改写：build_state_proposal 不得改动传入的 deltas
    snap = json.dumps(deltas, ensure_ascii=False, sort_keys=True)
    B.build_state_proposal(answers, deltas, vals, prof, check)
    ok(json.dumps(deltas, ensure_ascii=False, sort_keys=True) == snap,
       "[E] 过滤过程不修改原始增量对象（原样保留给审计）")
    info("全量未过滤增量仍完整保留在 raw_deltas_all_signals / 这里的 deltas 里，"
         "但两者都不具备写入权限；写入属于 Narraverse 的 State Transition 层")
    RESULTS["E_proposal_only"] = {"is_proposal": sp.get("is_proposal"),
                                  "authority": sp.get("authority")}

    # ================================================================
    head("[F] 不可靠的 signal 会被正式状态系统自动忽略吗？")
    # ================================================================
    # 直接构造：把每个 state_shift signal 都灌进去，看过滤结果与档案是否一致
    if prof:
        sig = prof["signals"]
        exp_delta = set(n for n in B.SHIFT_IDS if sig[n]["status"] == "active")
        exp_aux = set(n for n in B.SHIFT_IDS if sig[n]["status"] == "auxiliary")
        exp_blk = set(n for n in B.SHIFT_IDS if sig[n]["status"] in ("disabled", "semantic_review"))
        got_delta = set(d["source_signal"] for d in sp["delta"])
        got_aux = set(d["source_signal"] for d in sp["auxiliary"])
        got_blk = set(d["source_signal"] for d in sp["ignored_signals"])
        ok(got_delta == exp_delta, "[F] active 集合一致", "、".join(sorted(got_delta)) or "（空）")
        ok(got_aux == exp_aux, "[F] auxiliary 集合一致", "、".join(sorted(got_aux)) or "（空）")
        ok(got_blk == exp_blk, "[F] 被拦下的集合一致", "、".join(sorted(got_blk)) or "（空）")
        if exp_blk:
            ok(all(sig[n]["grade"] in ("D", "R", "N") for n in exp_blk),
               "[F] 被拦下的 signal 等级都是 D/R/N（低判别力或反向）",
               "/".join("%s=%s" % (n, sig[n]["grade"]) for n in sorted(exp_blk)))
        # 反向信号必须被拦，且**不能**被静默取反
        rev = [n for n in names if sig[n]["grade"] == "R"]
        for n in rev:
            ok(n not in got_delta and n not in got_aux,
               "[F] 反向信号 %s 既没进 delta 也没进 auxiliary（禁止静默取反）" % n)
            ok(sig[n]["status"] == "semantic_review",
               "[F] 反向信号 %s 的 status 是 semantic_review（先去查语义，不是直接丢弃）" % n)
        # behavior_tendency / situation_assessment 一律不得写状态
        for r in bt + sa:
            ok(r["signal"] not in got_delta,
               "[F] role=%s 的 %s 不产生状态增量" % (r["role"], r["signal"]))
        bad_consume = [r["signal"] for r in bt + sa
                       if r["status"] in ("disabled", "semantic_review") and r["consumable"]]
        ok(not bad_consume, "[F] disabled / semantic_review 的信号一律标为不可消费",
           "、".join(bad_consume) or "无")
        RESULTS["F_ignore"] = {"active": sorted(exp_delta), "auxiliary": sorted(exp_aux),
                               "blocked": sorted(exp_blk),
                               "reversed": {n: sig[n]["status"] for n in rev}}

    # ================================================================
    head("附：english 对照档案（只做对照，不是生产候选）")
    # ================================================================
    if "english" in profs:
        ep, ec = B.load_capability_profile("english")
        esig = (ep or {}).get("signals") or profs["english"]["signals"]
        w = [n for n in names if (esig.get(n) or {}).get("may_write_state")]
        info("english 上可写 Actor State 的 signal：%s" % ("、".join(w) or "（无）"))
        typed_w = [n for n in names if (prof["signals"][n] or {}).get("may_write_state")] if prof else []
        info("typed-decisions 上可写的是：%s" % ("、".join(typed_w) or "（无）"))
        ok(w != typed_w or w == [],
           "★ 两个检查点可写状态的 signal **不同** —— 这就是「不能透明互换」的量化证据",
           "typed=%s ｜ english=%s" % ("、".join(typed_w), "、".join(w)))
        # 反向信号在 english 上的处理必须同样保守
        for n in names:
            if (esig.get(n) or {}).get("status") == "semantic_review":
                ok(not (esig.get(n) or {}).get("may_write_state"),
                   "[english] semantic_review 的 %s 不可写状态" % n)
        RESULTS["english_compare"] = {"english_writable": w, "typed_writable": typed_w}

    # ================================================================
    print("\n" + "=" * 78)
    print("PASS %d / FAIL %d ｜ SKIP %d" % (len(PASS), len(FAIL), len(SKIP)))
    print("=" * 78)
    if INFO:
        print("\n说明：")
        for m in INFO:
            print("  - %s" % m)
    if FAIL:
        print("\n未通过：")
        for f in FAIL:
            print("  ✗ %s" % f)

    if want_json:
        p = os.path.join(ROOT, "tests", "p2_acceptance.json")
        json.dump({"_readme": ["Phase3-P2 验收结果（tests/p2_acceptance.py 生成）。",
                               "PASS/FAIL 是断言级别的证据，用来回答提示词的验收问题 A–F。"],
                   "passed": PASS, "failed": FAIL, "skipped": SKIP, "notes": INFO,
                   "results": RESULTS},
                  open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print("\n已写入 tests/p2_acceptance.json")

    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
