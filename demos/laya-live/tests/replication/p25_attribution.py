"""P2.5 归因实验 —— 区分「模型不敏感」与「我把变化量当状态量问了」。

背景（必须按顺序读，否则会得出错误结论）：

  1. 主实验 `trust_context_probe.py`：6 个上下文 pair 的 trust_shift Δ 全为正
     （+0.046~+0.212），且与语义方向无关。
  2. 控制实验 `p25_control.py` 排除了两种自我欺骗：
     · 同态重复 3 次极差 0.0000 → 不是运行内抖动（模型确实 deterministic）；
     · 反序配对 Δ 精确反号（+0.0954 / −0.0954）→ **不是顺序效应**，
       Δ 确实来自 A/B 两态本身的状态差异。
     · 但「只改 relationship.trust（10→90）」全跨度仅 0.0513、非单调；
       「只改 dh 内容」全跨度 0.1294 且**方向与语义预期相反**
       （betrayed 2.3253 > helped 2.2307 > empty/helped_x3 2.1959）。
  3. 那 Δ 到底在测什么？看问句措辞就明白了：
       signal_trust (noul)  : "does `npc` **currently** trust the player?"   ← 状态量
       trust_shift  (score) : "How does `message` **change** the trust ..."  ← 变化量
     一个真正在问「这句话带来多少变化」的问题，其答案**本来就该由这句话主导**，
     上下文只应起二阶作用。所以「背叛史下这句话的 Δ 应该为负」这个预期，
     很可能是我把**状态量**的预期错安在**变化量**上 —— 那是我的设计错误，
     不是模型缺陷。

本脚本的作用就是把这两者分开：
    · 若 `signal_trust` 对同样的上下文**敏感**、而 `trust_shift` 不敏感
      → 说明模型能读到上下文，是**问题措辞**决定了读出的是状态还是变化量。
        结论应写成「trust_shift 是变化量，不应承担上下文敏感性的验收」，
        而不是「模型对上下文不敏感」。
    · 若两者都不敏感
      → 才是「模型对上下文不敏感」的强证据。

★ 本脚本不修改任何配置、不改问题定义、不调阈值。它只**观察**。
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
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]

import laya_bridge as B  # noqa: E402

OUT = os.path.join(ROOT, "_diag", "p25_attribution__%s.json" % (os.environ.get("LAYA_MODEL") or "typed-decisions"))

WATCH = ["trust_shift", "doubt_shift", "fondness_shift",          # 变化量（score）
         "trust", "doubt", "danger", "hostility"]                 # 状态量（noul）
# ★ 注意 key 名：signal_snapshot 返回的是**去掉 signal_ 前缀**的短名
#   （narra_config 的 signals.order 就是短名，question 字段才是 signal_xxx）。
#   第一版这里写成 "signal_trust"，于是 values.get() 全部落空、表格里一片 "-"，
#   看起来像「模型对状态量不返回任何东西」—— 差点把自己脚本的 bug 报成模型缺陷。


def main():
    model = B.DEFAULT_MODEL_NAME
    B.ENGINE.init()
    if not B.ENGINE.ready:
        print("laya 未就绪")
        return 1

    qs = B.build_laya_questions(B.CFG["questions"])
    actor0 = json.loads(json.dumps(B.CFG["actor"]))
    cache = {}
    try:
        cache = json.loads(B._XLATE_DISK.read_text(encoding="utf-8"))
    except Exception:
        pass

    def vals(text, rel, dh):
        a = json.loads(json.dumps(actor0))
        if rel:
            a["relationship"] = dict(rel)
        te = B._cached_translate(text, cache) if B.LANG == "en" else text
        doc = B.build_state_doc(a, text, [], B.CFG.get("scene"), None,
                                player_input_en=te, decision_history=dh)
        _, rows, by = B._run_signals(model, doc, qs)
        out = {}
        for n in WATCH:
            r = by.get(n)
            out[n] = None if r is None else round(float(r["value"]), 4)
        return out

    TEXT = "我把货放在城外的旧磨坊了，你自己去取吧。"
    DH_EMPTY = [{"type": "start", "summary": "the scene begins"}]
    DH_HELP = [{"type": "player_shielded_npc",
                "summary": "the player sent the city watch away from the NPC"},
               {"type": "start", "summary": "the scene begins"}]
    DH_BETRAY = [{"type": "player_sold_npc_whereabouts",
                  "summary": "the player told the watch where the NPC was staying"},
                 {"type": "start", "summary": "the scene begins"}]
    REL_LOW = {"trust": 15, "respect": 40, "doubt": 55, "reliance": 5}
    REL_HIGH = {"trust": 85, "respect": 70, "doubt": 15, "reliance": 60}
    REL_MID = {"trust": 55, "respect": 50, "doubt": 40, "reliance": 25}

    print("=" * 96)
    print("P2.5 归因实验 ｜ 检查点=%s ｜ 设备=%s" % (model, B.ENGINE.device_label()))
    print("问句同一句话：%s" % TEXT)
    print("=" * 96)

    # ---- 场景组 ----------------------------------------------------------
    scenes = [
        ("低信任 + 无史", REL_LOW, DH_EMPTY),
        ("高信任 + 无史", REL_HIGH, DH_EMPTY),
        ("中信任 + 帮助史", REL_MID, DH_HELP),
        ("中信任 + 背叛史", REL_MID, DH_BETRAY),
    ]
    table = {}
    for tag, rel, dh in scenes:
        table[tag] = vals(TEXT, rel, dh)

    hdr = "%-16s" % "场景" + "".join("%14s" % n for n in WATCH)
    print("\n" + hdr)
    print("-" * len(hdr))
    for tag, _r, _d in scenes:
        print("%-16s" % tag + "".join("%14s" % ("-" if table[tag][n] is None else "%.3f" % table[tag][n])
                                      for n in WATCH))

    # ---- 逐 signal 的「对上下文是否敏感」判定 ----------------------------
    print("\n── 逐 signal：这组上下文造成的全跨度 vs 噪声底 0.05 " + "-" * 40)
    print("   %-18s %-9s %8s %8s %s" % ("signal", "类型", "全跨度", "越噪?", "方向是否语义一致"))
    attr = {}
    for n in WATCH:
        ys = [table[t][n] for t, _a, _b in scenes if table[t][n] is not None]
        if len(ys) < 4:
            continue
        span = max(ys) - min(ys)
        kind = "变化量(score)" if n.endswith("_shift") else "状态量(noul)"
        # 语义一致性：低信任 < 高信任（状态量）；帮助史 vs 背叛史 也检查
        lo, hi = table["低信任 + 无史"][n], table["高信任 + 无史"][n]
        hp, bt = table["中信任 + 帮助史"][n], table["中信任 + 背叛史"][n]
        if n in ("trust", "doubt"):
            rel_ok = (lo < hi) if n == "trust" else (lo > hi)
            hist_ok = (hp > bt) if n == "trust" else (hp < bt)
        else:
            rel_ok = hist_ok = None
        attr[n] = {"kind": kind, "span": round(span, 4), "beyond": span >= B._NOISE_FLOOR,
                   "low_vs_high_rel": [lo, hi], "help_vs_betray": [hp, bt],
                   "rel_dir_ok": rel_ok, "hist_dir_ok": hist_ok,
                   "values": dict((t, table[t][n]) for t, _a, _b in scenes)}
        print("   %-18s %-11s %8.4f %8s %s"
              % (n, kind, span, "是" if attr[n]["beyond"] else "否",
                 ("关系轴%s / 历史轴%s" % ("✓" if rel_ok else "✗" if rel_ok is False else "-",
                                        "✓" if hist_ok else "✗" if hist_ok is False else "-"))
                 if rel_ok is not None else "（变化量不预设方向）"))

    sh = [n for n in WATCH if n.endswith("_shift")]
    st = [n for n in WATCH if not n.endswith("_shift")]
    sh_span = max(attr[n]["span"] for n in sh if n in attr) if any(n in attr for n in sh) else None
    st_span = max(attr[n]["span"] for n in st if n in attr) if any(n in attr for n in st) else None
    print("\n   ★ 变化量组最大跨度=%.4f ｜ 状态量组最大跨度=%.4f" % (sh_span or -1, st_span or -1))
    if st_span and sh_span and st_span > sh_span * 1.8:
        print("   → 状态量对上下文明显更敏感。这支持「问题措辞决定读出状态还是变化量」，")
        print("     而不是「模型对上下文不敏感」。")
    else:
        print("   → 两组跨度接近，不能据此区分；需人工看逐 signal 的方向列。")

    res = {"checkpoint": model, "text": TEXT, "table": table, "attribution": attr,
           "span_shift_group": sh_span, "span_state_group": st_span}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
    print("\n已写入 %s" % os.path.relpath(OUT, ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
