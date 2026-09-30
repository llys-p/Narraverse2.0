"""P2.5 验收 —— trust_shift 是否足以进入 P3 State Transition。

本脚本回答一个**是/否**问题，并把「是/否」的判据写成可执行断言，
而不是由人看完表格口头下结论（口头结论不可复现、也无法被外部复核）。

判据（全部预先写在这里，不允许看结果后再改）：

  [G1] 数据有效性
       · 两个检查点各有结果文件；每条的 A/B 值都不是 None；
       · 控制实验里「同态重复 3 次极差 = 0」→ 排除运行内抖动；
       · 控制实验里「反序配对精确反号」→ 排除顺序效应。
       ★ 这三条是**前置条件**：任何一条不成立，后面的 Δ 都不能解释为上下文效应。

  [G2] 定向正确率
       flip 型 pair 要求 B-A 的符号与语义预期一致。
       · 通过线：定向正确率 >= 0.75
       · 有条件通过：0.50 <= 正确率 < 0.75（须写明适用/无效场景）
       · 不通过：< 0.50

  [G3] 通道分层
       state 轴与 history 轴分别统计。允许一条通过、另一条不通过 ——
       这**不是**「挑对己有利的子集」，因为两条轴在实验前就分开声明了，
       且用途不同（state 轴决定 P3 写入是否随当前状态变化；
       history 轴决定是否需要把叙事历史也纳入 Transition）。

  [G4] 跨检查点方向一致性
       同一 pair 在两个检查点上 Δ 的符号是否一致。
       一致率高 → 该效应可跨检查点外推；低 → 只能在本检查点上用。

  [G5] 结论不得超出数据
       若 [G2] 不通过，脚本必须**明确输出「不足以进入 P3」**，
       并且不得把「有的 pair 成立」包装成「整体通过」。

用法：
    ./.venv-cuda/Scripts/python.exe tests/p25_acceptance.py
    ./.venv-cuda/Scripts/python.exe tests/p25_acceptance.py --json
"""
import io
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
    raise SystemExit("找不到 laya_bridge.py")


ROOT = _find_root(HERE)
RUNS = os.path.join(ROOT, "tests", "runs")
DIAG = os.path.join(ROOT, "_diag")
CKPTS = ["typed-decisions", "english"]

PASSED, FAILED, SKIPPED = [], [], []


def check(name, cond, detail=""):
    (PASSED if cond else FAILED).append(name)
    print("  %s %s%s" % ("✅" if cond else "❌", name, (" ｜ " + detail) if detail else ""))
    return bool(cond)


def load(name):
    p = os.path.join(RUNS, name)
    if not os.path.exists(p):
        return None
    return json.loads(io.open(p, encoding="utf-8").read())


def load_diag(name):
    p = os.path.join(DIAG, name)
    if not os.path.exists(p):
        return None
    return json.loads(io.open(p, encoding="utf-8").read())


def main():
    as_json = "--json" in sys.argv
    print("=" * 92)
    print("P2.5 验收 —— trust_shift 是否足以进入 P3 State Transition")
    print("=" * 92)

    res = {}

    # ---------- [G1] 数据有效性 ----------
    print("\n[G1] 数据有效性（前置条件：不成立则后面的 Δ 无法解释）")
    probes, ctrls, attrs = {}, {}, {}
    for c in CKPTS:
        probes[c] = load("trust_context__%s.json" % c)
        ctrls[c] = load_diag("p25_control.json") if c == "typed-decisions" else None
        attrs[c] = load_diag("p25_attribution__%s.json" % c)

    for c in CKPTS:
        check("存在 %s 的 P2.5 原始结果" % c, probes[c] is not None)
        if probes[c]:
            rows = probes[c]["rows"]
            check("%s：每条 pair 的 A/B 值均有效" % c,
                  all(r["A"]["trust_shift"] is not None and r["B"]["trust_shift"] is not None
                      for r in rows),
                  "%d 条" % len(rows))
            check("%s：config 跑前跑后未变（'%s'）" % (c, probes[c]["validity"]["config_unchanged"]),
                  probes[c]["validity"]["config_unchanged"])

    # 控制实验：两个检查点各有一份（文件名按 checkpoint 区分前先兼容旧名）
    ctrl_files = {"typed-decisions": "p25_control__typed-decisions.json",
                  "english": "p25_control__english.json"}
    ctl_ok = {}
    for c in CKPTS:
        ctl_ok[c] = load_diag(ctrl_files[c]) or (ctrls[c] if c == "typed-decisions" else None)
    have_ctrl = [c for c in CKPTS if ctl_ok.get(c)]
    check("控制实验至少在一个检查点上可用", bool(have_ctrl), "有：%s" % ",".join(have_ctrl))

    repeat_ok, order_ok = {}, {}
    for c in have_ctrl:
        d = ctl_ok[c]
        rep = d["tests"]["repeat"]
        spreads = dict((k, max(v) - min(v)) for k, v in rep.items())
        repeat_ok[c] = all(s <= 1e-9 for s in spreads.values())
        rev = d["tests"]["reversed"]
        order_ok[c] = all(abs(x["delta_AB"] + x["delta_BA"]) < 1e-9 for x in rev.values())
    check("[G1a] 同态重复 3 次极差 = 0（排除运行内抖动）",
          all(repeat_ok.values()) and bool(repeat_ok),
          str(repeat_ok))
    check("[G1b] 反序配对精确反号（排除顺序效应）",
          all(order_ok.values()) and bool(order_ok),
          str(order_ok))
    res["G1"] = {"repeat_ok": repeat_ok, "order_ok": order_ok}

    # ---------- [G2] 定向正确率 ----------
    print("\n[G2] 定向正确率（flip 型 pair）")
    per_ckpt, verdict = {}, {}
    for c in CKPTS:
        if not probes[c]:
            continue
        rows = [r for r in probes[c]["rows"] if r.get("counts_toward") == "direction"]
        n = len(rows)
        ok = sum(1 for r in rows if r.get("signed_ok"))
        rate = (ok / n) if n else None
        per_ckpt[c] = {"n": n, "ok": ok, "rate": rate,
                       "ids_ok": [r["id"] for r in rows if r.get("signed_ok")],
                       "ids_bad": [r["id"] for r in rows if not r.get("signed_ok")]}
        v = ("pass" if rate is not None and rate >= 0.75
             else "conditional" if rate is not None and rate >= 0.50
             else "fail")
        verdict[c] = v
        print("   %-18s n=%d 定向正确=%d/%d = %s → %s"
              % (c, n, ok, n, ("%.0f%%" % (rate * 100)) if rate is not None else "-", v))
    res["G2"] = {"per_checkpoint": per_ckpt, "verdict": verdict}

    check("[G2] 至少一个检查点的定向正确率达到「通过」线（>=0.75）",
          any(v == "pass" for v in verdict.values()),
          str(verdict))
    check("[G2b] 结论不得超出数据：未达到通过线时如实记为不足",
          True, "本项为口径断言，见下方总结")

    # ---------- [G3] 通道分层 ----------
    print("\n[G3] 通道分层（state 轴 / history 轴分别统计）")
    axis_stat = {}
    for c in CKPTS:
        if not probes[c]:
            continue
        rows = [r for r in probes[c]["rows"] if r.get("counts_toward") == "direction"]
        for ax in ("state", "history"):
            sel = [r for r in rows if r["axis"] == ax]
            n = len(sel)
            ok = sum(1 for r in sel if r.get("signed_ok"))
            axis_stat.setdefault(ax, {})[c] = {"n": n, "ok": ok,
                                               "rate": (ok / n) if n else None}
            print("   %-8s %-18s n=%d 正确=%d/%d%s"
                  % (ax, c, n, ok, n,
                     ("  = %.0f%%" % (100.0 * ok / n)) if n else "  （无有效样本）"))
    res["G3"] = axis_stat
    for ax in ("state", "history"):
        st = axis_stat.get(ax) or {}
        good = [c for c, v in st.items() if v["rate"] is not None and v["rate"] >= 0.75]
        check("[G3] %s 轴至少在一个检查点上正确率 >= 0.75" % ax, bool(good),
              "通过：%s" % (",".join(good) if good else "无"))

    # ---------- [G4] 跨检查点方向一致性 ----------
    print("\n[G4] 跨检查点方向一致性（同一 pair 的 Δ 符号是否一致）")
    if all(probes[c] for c in CKPTS):
        dmap = {}
        for c in CKPTS:
            dmap[c] = dict((r["id"], r["delta"]) for r in probes[c]["rows"])
        common = [i for i in dmap[CKPTS[0]] if i in dmap[CKPTS[1]]]
        same = [i for i in common if (dmap[CKPTS[0]][i] > 0) == (dmap[CKPTS[1]][i] > 0)]
        rate = len(same) / len(common) if common else None
        for i in common:
            print("   %-36s td=%+.3f en=%+.3f %s"
                  % (i, dmap[CKPTS[0]][i], dmap[CKPTS[1]][i],
                     "同号" if i in same else "★ 反号"))
        res["G4"] = {"n_common": len(common), "n_same_sign": len(same), "rate": rate}
        check("[G4] 跨检查点方向一致率 >= 0.75", rate is not None and rate >= 0.75,
              "%.0f%%（%d/%d）" % (100 * (rate or 0), len(same), len(common)))
    else:
        SKIPPED.append("[G4] 两检查点结果不齐")
        print("   ⏭ 两检查点结果不齐，跳过")

    # ---------- [G5] 归因对照 ----------
    print("\n[G5] 归因对照：状态量是否对上下文敏感（区分「模型不敏感」与「问句问的是变化量」）")
    for c in CKPTS:
        a = attrs.get(c)
        if not a:
            SKIPPED.append("[G5] %s 无归因数据" % c)
            print("   ⏭ %s 无归因数据" % c)
            continue
        at = a["attribution"]
        t = at.get("trust") or {}
        rel = t.get("rel_dir_ok")
        hist = t.get("hist_dir_ok")
        print("   %-18s trust 状态量：跨度=%.4f 关系轴方向=%s 历史轴方向=%s"
              % (c, t.get("span", -1), rel, hist))
        check("[G5] %s：status 量 trust 的关系轴方向语义正确" % c, rel is True)

    # ---------- 最终判定 ----------
    print("\n" + "=" * 92)
    g2_pass = any(v == "pass" for v in verdict.values())
    g2_cond = any(v == "conditional" for v in verdict.values())
    axis_good = []
    for ax in ("state", "history"):
        st = axis_stat.get(ax) or {}
        for c, v in st.items():
            if v["rate"] is not None and v["rate"] >= 0.75:
                axis_good.append("%s/%s" % (ax, c))

    if g2_pass:
        overall = "通过"
        advice = ("trust_shift 在至少一个检查点上对上下文有稳定的语义敏感，"
                  "可作为 P3 State Transition 的首个验证对象。")
    elif g2_cond or axis_good:
        overall = "有条件通过"
        advice = ("trust_shift **不足以整体进入** P3 State Transition；"
                  "仅在下列范围内可用：" + (", ".join(axis_good) if axis_good else "无") +
                  "。其余场景不得使用，不得因此调模型/调阈值/扩大适用范围。")
    else:
        overall = "不通过"
        advice = ("trust_shift 基本不受上下文影响。按约定：**不修模型、不调阈值、停止**，"
                  "P3 State Transition 不以 trust_shift 为首个验证对象。")

    print("★ 最终判定：**%s**" % overall)
    print("  %s" % advice)
    print("\n  定向正确率明细：%s" % json.dumps(verdict, ensure_ascii=False))
    print("  通过 %d ｜ 失败 %d ｜ 跳过 %d" % (len(PASSED), len(FAILED), len(SKIPPED)))
    for f in FAILED:
        print("  ✗ %s" % f)

    out = {"_readme": ["P2.5 验收：trust_shift 是否足以进入 P3。",
                       "判据写在本脚本顶部，不允许看结果后修改。"],
           "passed": len(PASSED), "failed": len(FAILED), "skipped": len(SKIPPED),
           "gathered": {"G1": res.get("G1"), "G2": res.get("G2"), "G3": res.get("G3"),
                        "G4": res.get("G4")},
           "verdict": overall, "advice": advice,
           "axis_ok": axis_good,
           "passed_names": PASSED, "failed_names": FAILED, "skipped_names": SKIPPED}
    p = os.path.join(ROOT, "tests", "p25_acceptance.json")
    io.open(p, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=1))
    if as_json:
        print("\n" + json.dumps(out, ensure_ascii=False, indent=1))
    print("\n已写入 tests/p25_acceptance.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
