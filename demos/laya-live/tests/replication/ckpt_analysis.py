"""跨检查点对照分析（English 复现实验）。

输入：tests/runs/{typed-decisions,english}__run{1,2,3}.json —— 由 signalmetrics 掉盘的原始结果。
输出：控制台表 + tests/ckpt_replication.json（供报告引用）。

★ 为什么必须 3 次：P1 实测同条件重跑的 AUC 中位区间 0.013、最大 0.073。
  单次运行的 AUC 里含「跑次抖动」，而 bootstrap CI 只覆盖**同一次运行内**的重采样方差 ——
  它**不**覆盖跑次之间那部分。所以给单次 AUC 贴一个 CI 会让人以为结论很稳，
  实际上下一次跑就可能翻。本脚本因此把「跑次区间」和「CI」并排列出，不合并。

★ 分级规则不在本脚本里重写 —— 全部直接读 signalmetrics 里已经算好的 grade，
  本脚本只做「同一 signal 在不同检查点/不同跑次之间」的比较。这样「冻结评分规则」
  这条不需要靠自觉，而是结构上做不到改。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _find_root(start):
    """向上找含 laya_bridge.py 的目录 —— 脚本换位置后不用改路径。"""
    d = start
    for _ in range(4):
        if os.path.exists(os.path.join(d, "laya_bridge.py")):
            return d
        d = os.path.dirname(d)
    raise SystemExit("找不到 laya_bridge.py；脚本必须放在 laya-live/ 之内")


ROOT = _find_root(HERE)
RUNS = os.path.join(ROOT, "tests", "runs")

CKPTS = ["typed-decisions", "english"]
LABEL = {"typed-decisions": "typed-decisions", "english": "english"}
NRUN = (1, 2, 3)

ORDER = ["hostility", "cooperation", "withdraw", "confront", "disclose", "investigate",
         "trust", "doubt", "danger",
         "trust_shift", "respect_shift", "doubt_shift", "fondness_shift",
         "alert_shift", "goal_shift"]

KIND = {}


def load():
    out = {}
    for c in CKPTS:
        rs = []
        for i in NRUN:
            p = os.path.join(RUNS, "%s__run%d.json" % (c, i))
            if os.path.exists(p):
                rs.append(json.load(open(p, encoding="utf-8")))
        out[c] = rs
    return out


def med(xs):
    xs = sorted(xs)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2.0


def rng(xs):
    xs = [x for x in xs if x is not None]
    return (max(xs) - min(xs)) if len(xs) >= 2 else None


def rep_ci(vals, cis):
    """取 AUC 最接近中位数的那一次运行的 CI 作为代表（并注明它只覆盖同次内重采样）。"""
    ok = [(v, ci) for v, ci in zip(vals, cis) if v is not None and ci]
    if not ok:
        return None, None
    m = med([v for v, _ in ok])
    best = min(ok, key=lambda t: abs(t[0] - m))
    return best[1], best[0]


def main():
    runs = load()
    for c in CKPTS:
        if len(runs[c]) < 3:
            print("★ %s 只有 %d 次运行 —— 结论会不稳，先补齐 3 次。" % (c, len(runs[c])))
    if any(len(runs[c]) == 0 for c in CKPTS):
        print("缺少运行结果，先跑 signalmetrics。")
        return 1

    # ---- 采集 --------------------------------------------------------
    D = {}   # (ckpt, signal) -> {"aucs":[], "cis":[], "grades":[], "thrs":[], "gaps":[], "kind":}
    X = {}   # (ckpt, signal) -> {"signed":[], "grades":[], "sign_rate":[], "beyond":[], "n":[]}
    ACC = {}
    for c in CKPTS:
        for s in ORDER:
            aucs, cis, grs, thrs, gaps, kinds = [], [], [], [], [], []
            for r in runs[c]:
                d = (r.get("discrimination") or {}).get(s) or {}
                aucs.append(d.get("auc"))
                cis.append(d.get("auc_ci"))
                grs.append(d.get("grade"))
                thrs.append(d.get("best_threshold"))
                gaps.append(d.get("mean_gap"))
                if d.get("kind"):
                    kinds.append(d["kind"])
            D[(c, s)] = {"aucs": aucs, "cis": cis, "grades": grs, "thresholds": thrs,
                         "gaps": gaps, "kind": kinds[0] if kinds else None}
            sv, xg, sr, bd, nn = [], [], [], [], []
            for r in runs[c]:
                x = (r.get("contextual") or {}).get(s)
                if not x:
                    continue
                sv.append(x.get("mean_signed"))
                xg.append(x.get("grade"))
                sr.append(x.get("sign_rate"))
                bd.append(x.get("share_beyond"))
                nn.append(x.get("n"))
            X[(c, s)] = {"signed": sv, "grades": xg, "sign_rate": sr,
                         "beyond": bd, "n": nn}
        ACC[c] = [((r.get("observable_accuracy") or {}).get("rate"),
                   (r.get("observable_accuracy") or {}).get("passed"),
                   (r.get("observable_accuracy") or {}).get("total")) for r in runs[c]]

    # 最终等级：优先读 final_grades，缺失时按 combine 语义回落（disc）
    FIN = {}
    for c in CKPTS:
        for s in ORDER:
            gs = []
            for r in runs[c]:
                f = (r.get("final_grades") or {}).get(s) or {}
                gs.append(f.get("final") or (r.get("discrimination") or {}).get(s, {}).get("grade"))
            FIN[(c, s)] = gs

    # ---- 1) 逐 signal 主对照表 ---------------------------------------
    print("=" * 118)
    print("跨检查点对照：逐 signal（AUC 取 3 次运行 + 中位；区间 = 跑次内 max-min）")
    print("★ CI 只覆盖「同一次运行内」的 bootstrap 重采样，**不覆盖跑次抖动** —— 两者并排看，别只看 CI。")
    print("=" * 118)
    hdr = ("  %-15s %-6s | %-22s %-8s %-7s | %-22s %-8s %-7s | %-14s %-14s"
           % ("signal", "kind", "typed-decisions AUC 1/2/3", "中位", "区间",
              "english AUC 1/2/3", "中位", "区间", "td 最终", "en 最终"))
    print(hdr)
    print("  " + "-" * 114)

    def fmt3(xs):
        return " ".join(("%.3f" % x) if x is not None else "  —— " for x in xs)

    rows = {}
    for s in ORDER:
        d_td, d_en = D[("typed-decisions", s)], D[("english", s)]
        g_td, g_en = FIN[("typed-decisions", s)], FIN[("english", s)]
        rows[s] = {
            "kind": d_td["kind"] or d_en["kind"],
            "td": {"aucs": d_td["aucs"], "median": med([x for x in d_td["aucs"] if x is not None]),
                   "range": rng(d_td["aucs"]), "grades": g_td,
                   "disc_grades": d_td["grades"],
                   "thresholds": d_td["thresholds"], "gaps": d_td["gaps"],
                   "ci": rep_ci(d_td["aucs"], d_td["cis"])[0],
                   "ci_rep_auc": rep_ci(d_td["aucs"], d_td["cis"])[1],
                   "gap_med": med([x for x in d_td["gaps"] if x is not None]),
                   "thr_med": med([x for x in d_td["thresholds"] if x is not None]),
                   "ctx_signed_med": med([x for x in X[("typed-decisions", s)]["signed"] if x is not None]),
                   "ctx_grades": X[("typed-decisions", s)]["grades"],
                   "ctx_sign_rate": med([x for x in X[("typed-decisions", s)]["sign_rate"] if x is not None])},
            "en": {"aucs": d_en["aucs"], "median": med([x for x in d_en["aucs"] if x is not None]),
                   "range": rng(d_en["aucs"]), "grades": g_en,
                   "disc_grades": d_en["grades"],
                   "thresholds": d_en["thresholds"], "gaps": d_en["gaps"],
                   "ci": rep_ci(d_en["aucs"], d_en["cis"])[0],
                   "ci_rep_auc": rep_ci(d_en["aucs"], d_en["cis"])[1],
                   "gap_med": med([x for x in d_en["gaps"] if x is not None]),
                   "thr_med": med([x for x in d_en["thresholds"] if x is not None]),
                   "ctx_signed_med": med([x for x in X[("english", s)]["signed"] if x is not None]),
                   "ctx_grades": X[("english", s)]["grades"],
                   "ctx_sign_rate": med([x for x in X[("english", s)]["sign_rate"] if x is not None])},
        }
        print("  %-15s %-6s | %-22s %-8s %-7s | %-22s %-8s %-7s | %-14s %-14s"
              % (s, rows[s]["kind"], fmt3(d_td["aucs"]),
                 ("%.3f" % rows[s]["td"]["median"]) if rows[s]["td"]["median"] is not None else "—",
                 ("%.3f" % rows[s]["td"]["range"]) if rows[s]["td"]["range"] is not None else "—",
                 fmt3(d_en["aucs"]),
                 ("%.3f" % rows[s]["en"]["median"]) if rows[s]["en"]["median"] is not None else "—",
                 ("%.3f" % rows[s]["en"]["range"]) if rows[s]["en"]["range"] is not None else "—",
                 "/".join(str(x) for x in g_td), "/".join(str(x) for x in g_en)))

    # ---- 2) 三分类 ---------------------------------------------------
    def classify(gs_td, gs_en):
        """三分类 + 一个额外桶（N=样本不足，不进三分类）。

        优先级（写死在代码里，避免事后挑一个好听的桶）：
          ① 若任一次运行分出 R（稳定反向）→ 不可靠-反向
          ② 若同一检查点内 3 次运行等级不一致 → 不可靠（跑次之间不稳）
          ③ 两个检查点等级集合相同 → 跨检查点稳定
          ④ 否则 → 检查点特有
        """
        allg = list(gs_td) + list(gs_en)
        if all(g == "N" for g in allg):
            return "N 样本不足"
        if "R" in allg:
            return "③ 不可靠-反向"
        if len(set(gs_td)) > 1 or len(set(gs_en)) > 1:
            return "③ 不可靠（跑次不一致）"
        if set(gs_td) == set(gs_en):
            return "① 跨检查点稳定"
        return "② 检查点特有"

    print("\n" + "=" * 118)
    print("三分类（规则写死在 classify()，优先级：反向 > 跑次不一致 > 稳定 > 检查点特有）")
    print("=" * 118)
    cls_count = {}
    for s in ORDER:
        c = classify(rows[s]["td"]["grades"], rows[s]["en"]["grades"])
        rows[s]["class"] = c
        cls_count[c] = cls_count.get(c, 0) + 1
        print("  %-15s %-22s   td=%s   en=%s"
              % (s, c, "/".join(str(x) for x in rows[s]["td"]["grades"]),
                 "/".join(str(x) for x in rows[s]["en"]["grades"])))
    print("\n  分类计数：")
    for k in sorted(cls_count):
        print("    %-22s %d 个：%s" % (k, cls_count[k],
              "、".join(s for s in ORDER if rows[s]["class"] == k)))

    # ---- 3) 跑次方差对比（问 h）--------------------------------------
    print("\n" + "=" * 118)
    print("跑次方差对比（问 h）：同一检查点内，每个 signal 的 AUC 跑次区间")
    print("=" * 118)
    var = {}
    for c in CKPTS:
        rs = [rows[s][("td" if c == "typed-decisions" else "en")]["range"] for s in ORDER]
        rs = [x for x in rs if x is not None]
        var[c] = {"median_range": med(rs), "max_range": max(rs) if rs else None,
                  "mean_range": (sum(rs) / len(rs)) if rs else None, "n": len(rs),
                  "gt_0.02": sum(1 for x in rs if x > 0.02)}
        print("  %-16s 中位区间 %.4f ｜ 均值 %.4f ｜ 最大 %.4f ｜ >0.02 的 %d/%d 个"
              % (c, var[c]["median_range"], var[c]["mean_range"], var[c]["max_range"],
                 var[c]["gt_0.02"], var[c]["n"]))
    better = min(CKPTS, key=lambda c: var[c]["median_range"])
    print("  ▸ 跑次更稳的是：**%s**（中位区间 %.4f）" % (better, var[better]["median_range"]))

    # ---- 3b) 确定性核对：3 次运行到底是不是同一份结果 -------------------
    print("\n" + "=" * 118)
    print("确定性核对：同一检查点 3 次运行的 AUC 有几个是完全相同的？")
    print("★ 这条决定「3 次运行」提供了多少额外信息。全同 → 该检查点在本机型上是确定性的；")
    print("  此时「跑次区间 = 0」**不等于**「结论很稳」，只等于「没跑出新东西」——")
    print("  它排除不了「换个用例集就翻」这类风险，所以不能当作稳定性的证据来用。")
    print("=" * 118)
    determ = {}
    for c in CKPTS:
        k = "td" if c == "typed-decisions" else "en"
        same = [s for s in ORDER if len(set(str(x) for x in rows[s][k]["aucs"])) == 1]
        diff = [s for s in ORDER if s not in same]
        determ[c] = {"n_identical": len(same), "n_diff": len(diff), "diff_signals": diff}
        print("  %-16s 15 个 signal 中 %d 个 3 次完全相同；有差异的 %d 个：%s"
              % (c, len(same), len(diff), "、".join(diff) or "无"))
        for s in diff:
            v = [x for x in rows[s][k]["aucs"]]
            print("        %-15s %s  极差 %.4f" % (s, " ".join("%.4f" % x for x in v), rng(v) or 0))
    print("  缓存哈希（每次运行前断言完备 + 运行后核对）：")
    for c in CKPTS:
        shas = [(r.get("validity") or {}).get("cache_sha", "")[:16] for r in runs[c]]
        chg = [(r.get("validity") or {}).get("cache_changed_during_run") for r in runs[c]]
        print("    %-16s %s ｜ 运行中被改写：%s"
              % (c, " ".join(shas), chg))
    # ---- 4) 口径核对：A 级到底几个（问 b）---------------------------
    print("\n" + "=" * 118)
    print("口径核对（问 b）：同一个检查点里「A 级」有**三个不同的数**，必须先说清用哪个口径")
    print("=" * 118)
    counts = {}
    for c in CKPTS:
        r0 = runs[c][0]
        disc = r0.get("discrimination") or {}
        fin = r0.get("final_grades") or {}
        dA = [s for s in ORDER if (disc.get(s) or {}).get("grade") == "A"]
        lvlA = [s for s in dA if (disc.get(s) or {}).get("kind") == "level"]
        probA = [s for s in dA if (disc.get(s) or {}).get("kind") == "prob"]
        fA = [s for s in ORDER if (fin.get(s) or {}).get("final") == "A"]
        counts[c] = {"disc_A_all": dA, "disc_A_level": lvlA, "disc_A_prob": probA,
                     "final_A": fA}
        print("  [%s]" % c)
        print("    ① 判别力口径 · 全部 signal A 级：%d 个 → %s" % (len(dA), "、".join(dA) or "无"))
        print("       其中 level 组 %d 个：%s" % (len(lvlA), "、".join(lvlA) or "无"))
        print("       其中 prob/noul 组 %d 个：%s" % (len(probA), "、".join(probA) or "无"))
        print("    ② 最终口径 min(判别,上下文) A 级：%d 个 → %s" % (len(fA), "、".join(fA) or "无"))
        dropped = [s for s in dA if s not in fA]
        if dropped:
            print("       判别力 A 但最终不是 A 的：%s" % "、".join(
                "%s(判别A→最终%s)" % (s, (fin.get(s) or {}).get("final")) for s in dropped))

    # ---- 5) 逐个回答 8 个问题 ----------------------------------------
    print("\n" + "=" * 118)
    print("逐条回答（english 为准，同时列 typed-decisions 以判断是否 checkpoint 特有）")
    print("=" * 118)

    qa = {}

    # (a)
    trio = ["trust_shift", "doubt_shift", "fondness_shift"]
    print("\n(a) trust_shift / doubt_shift / fondness_shift 在 english 上是否仍有高判别力？")
    ok_all = True
    for s in trio:
        en = rows[s]["en"]
        td = rows[s]["td"]
        print("    %-15s en AUC %s 中位 %.3f 区间 %s 最终=%s ｜ td 中位 %.3f 最终=%s"
              % (s, fmt3(en["aucs"]), en["median"] or 0, en["range"], "/".join(str(x) for x in en["grades"]),
                 td["median"] or 0, "/".join(str(x) for x in td["grades"])))
        if not all(g == "A" for g in en["grades"]):
            ok_all = False
    qa["a_trio_hold_on_english"] = ok_all
    print("    ▸ %s" % ("三个都稳定 A —— 判别力不是 typed-decisions 独有。"
                        if ok_all else "★ 并非三个都稳定 A，见上行。"))

    # (c)
    print("\n(c) 8 个 noul / prob 型 signal 在 english 上是否仍然全部没有 A 级？")
    prob_names = [s for s in ORDER if rows[s]["kind"] == "prob"]
    enA = [s for s in prob_names if all(g == "A" for g in rows[s]["en"]["grades"])]
    tdA = [s for s in prob_names if all(g == "A" for g in rows[s]["td"]["grades"])]
    print("    prob 组 %d 个：%s" % (len(prob_names), "、".join(prob_names)))
    print("    english  上 discrim-A：%s" % ("、".join(enA) or "无"))
    print("    td       上 discrim-A：%s" % ("、".join(tdA) or "无"))
    qa["c_prob_all_no_A_on_english"] = (len(enA) == 0)
    if enA or tdA:
        print("    ★ 注意：这条在 typed-decisions 上**本来就不成立** —— 见下方口径核对。")

    # (d)
    print("\n(d) noul 的最佳阈值是否仍聚在 0.35~0.53？")
    for c in CKPTS:
        ths = []
        for s in prob_names:
            ths += [t for t in rows[s][("td" if c == "typed-decisions" else "en")]["thresholds"]
                    if t is not None]
        inband = sum(1 for t in ths if 0.35 <= t <= 0.53)
        print("    %-16s 阈值 %d 个：min %.3f max %.3f ｜ 落在 0.35~0.53 的 %d/%d"
              % (c, len(ths), min(ths), max(ths), inband, len(ths)))
    qa["d_thresholds_cluster_note"] = "阈值是统计输出，不回写配置"

    # (e)
    print("\n(e) disclose 是否仍是 AUC<0.5 / 稳定反向？")
    for c in CKPTS:
        k = "td" if c == "typed-decisions" else "en"
        a = rows["disclose"][k]
        print("    %-16s AUC %s 中位 %.3f 区间 %s 最终=%s"
              % (c, fmt3(a["aucs"]), a["median"] or 0, a["range"], "/".join(str(x) for x in a["grades"])))
    qa["e_disclose_reversed"] = {
        c: {"median": rows["disclose"][("td" if c == "typed-decisions" else "en")]["median"]}
        for c in CKPTS}

    # (f)(g)
    print("\n(f) investigate 的上下文效应是否仍然下降？")
    for c in CKPTS:
        x = X[(c, "investigate")]
        print("    %-16s 定向均Δ %s ｜ 方向对率 %s ｜ 等级 %s"
              % (c, ["%.3f" % v for v in x["signed"]], ["%.0f%%" % (v * 100) for v in x["sign_rate"]],
                 "/".join(str(g) for g in x["grades"])))
    print("\n(g) 「上下文信号对前文几乎无反应」是否复现？")
    for c in CKPTS:
        cov = [s for s in ORDER if X[(c, s)]["signed"]]
        loud = [s for s in cov if med([abs(v) for v in X[(c, s)]["signed"]]) >= 0.05]
        print("    %-16s 有上下文数据的 %d 个；中位|定向Δ| ≥ 噪声底 0.05 的：%s"
              % (c, len(cov), "、".join(loud) or "无"))
        for s in cov:
            m = med([abs(v) for v in X[(c, s)]["signed"]])
            print("        %-15s 中位|Δ|=%.4f  等级=%s" % (s, m, "/".join(str(g) for g in X[(c, s)]["grades"])))

    # (h)
    qa["h_stabler_checkpoint"] = better

    # ---- 6) 总体准确率 + 有效性 --------------------------------------
    print("\n" + "=" * 118)
    print("附：observable 总体方向准确率（只作背景，**不是主结论**）与有效性过滤")
    print("=" * 118)
    for c in CKPTS:
        vals = [x[0] for x in ACC[c] if x[0] is not None]
        print("  %-16s %s ｜ 中位 %.1f%%" % (c, " ".join("%.1f%%" % (v * 100) for v in vals),
                                             100 * med(vals)))
    for c in CKPTS:
        v = (runs[c][0].get("validity") or {})
        print("  %-16s room=%s token %s~%s 中位 %s ｜ 溢出 %s ｜ 剔除 %d 项"
              % (c, v.get("room"), v.get("token_min"), v.get("token_max"),
                 v.get("token_median"), v.get("n_overflow"), len(v.get("invalid") or [])))
        for it in (v.get("invalid") or []):
            print("        [%s/%s/%s] %s" % (it["set"], it["id"], it["role"], "；".join(it["reasons"])))

    # ---- 落盘 --------------------------------------------------------
    out = {"_readme": ["跨检查点复现实验的汇总（由 tests/replication/ckpt_analysis.py 生成）。",
                       "runs_dir = tests/runs/，每个检查点 3 次独立进程运行。",
                       "分级规则未在本脚本重写，全部读自 signalmetrics 的输出。",
                       "class 规则见 classify()：反向 > 跑次不一致 > 稳定 > 检查点特有。"],
           "n_runs": {c: len(runs[c]) for c in CKPTS},
           "rows": rows, "class_counts": cls_count, "variance": var,
           "grade_caliber": counts, "qa": {k: (v if not isinstance(v, dict) else v)
                                           for k, v in qa.items()},
           "observable_accuracy": {c: ACC[c] for c in CKPTS},
           "validity": {c: (runs[c][0].get("validity") or {}) for c in CKPTS},
           "contextual_detail": {c: {s: X[(c, s)] for s in ORDER if X[(c, s)]["signed"]}
                                 for c in CKPTS}}
    p = os.path.join(ROOT, "tests", "ckpt_replication.json")
    json.dump(out, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n已写入 tests/ckpt_replication.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
