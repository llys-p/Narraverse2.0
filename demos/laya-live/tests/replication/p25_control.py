"""P2.5 控制实验 —— 先证明「测量本身没有系统偏移」，再解释主实验的 Δ。

起因：主实验 `trust_context_probe.py` 在 typed-decisions 上 6/6 个 pair 的 Δ **全为正**
（+0.046 ~ +0.212），且符号与语义方向无关。这种「整齐的同号」有两种解释：
    (a) 模型真的对上下文敏感（但方向错）—— 那是模型问题；
    (b) 我的 A→B 调用顺序本身带来正向漂移 —— 那是**实验设计问题**，
        报成模型缺陷就是把自己的 bug 写成别人的缺陷。
不加控制实验就无法区分，所以本脚本专门做三件事：

  ① 同态重复：同一个 state 连跑 3 次。若三次不完全相同 → 存在运行内抖动，
     主实验的 |Δ| < 抖动幅度时不能解释为上下文效应。
  ② 反序配对：把 B 放到前面跑（B→A）。若仍然「后跑的更高」，
     说明是**顺序效应**而非上下文；若 Δ 反号，说明确实是 A/B 状态差异。
  ③ 空前文两态：两个 dh **内容相同**、只有 relationship.trust 不同。
     Δ 应当稳定地表征信任底色。

★ 本脚本不写结果文件到 tests/runs/（避免污染正式跑次目录），
   输出到 _diag/（已 gitignore），只在报告里引用数字。
"""
import hashlib
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

OUT = os.path.join(ROOT, "_diag", "p25_control__%s.json" % (os.environ.get("LAYA_MODEL") or "typed-decisions"))


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

    def doc(text, rel, dh):
        a = json.loads(json.dumps(actor0))
        if rel:
            a["relationship"] = dict(rel)
        te = B._cached_translate(text, cache) if B.LANG == "en" else text
        return B.build_state_doc(a, text, [], B.CFG.get("scene"), None,
                                 player_input_en=te, decision_history=dh)

    def tv(text, rel, dh):
        _, _, by = B._run_signals(model, doc(text, rel, dh), qs)
        r = by.get("trust_shift")
        return None if r is None else round(float(r["value"]), 4)

    # 用一句话 + 两个差异明确的上下文
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

    res = {"checkpoint": model, "text": TEXT, "tests": {}}

    print("=" * 88)
    print("P2.5 控制实验 ｜ 检查点=%s ｜ 设备=%s" % (model, B.ENGINE.device_label()))
    print("=" * 88)

    # ---- ① 同态重复：同一 state 连跑 3 次 -------------------------------
    print("\n① 同态重复（同一 state ×3）：这是「运行内抖动」的下界")
    rep = {}
    for tag, rel, dh in (("low/empty", REL_LOW, DH_EMPTY),
                         ("high/empty", REL_HIGH, DH_EMPTY),
                         ("mid/help", {"trust": 55, "respect": 50, "doubt": 40, "reliance": 25}, DH_HELP),
                         ("mid/betray", {"trust": 55, "respect": 50, "doubt": 40, "reliance": 25}, DH_BETRAY)):
        vals = [tv(TEXT, rel, dh) for _ in range(3)]
        rep[tag] = vals
        spread = max(vals) - min(vals)
        print("   %-12s %s ｜ 极差=%.4f %s"
              % (tag, vals, spread, "★ 非 determinism" if spread > 1e-9 else ""))
    res["tests"]["repeat"] = rep

    # ---- ② 反序配对：B→A ------------------------------------------------
    print("\n② 反序配对（先 B 后 A）：若「后跑的更高」则说明是顺序效应")
    pairs = [
        ("stranger_vs_companion", REL_LOW, REL_HIGH, DH_EMPTY),
        ("helped_vs_betrayed", {"trust": 55, "respect": 50, "doubt": 40, "reliance": 25},
         {"trust": 55, "respect": 50, "doubt": 40, "reliance": 25}, None),
    ]
    rev = {}
    for name, ra, rb, dh in pairs:
        if name == "helped_vs_betrayed":
            a = tv(TEXT, ra, DH_HELP)
            b = tv(TEXT, rb, DH_BETRAY)
            b2 = tv(TEXT, rb, DH_BETRAY)
            a2 = tv(TEXT, ra, DH_HELP)
        else:
            a = tv(TEXT, ra, dh)
            b = tv(TEXT, rb, dh)
            b2 = tv(TEXT, rb, dh)
            a2 = tv(TEXT, ra, dh)
        rev[name] = {"order_AB": [a, b], "delta_AB": round(b - a, 4),
                     "order_BA": [b2, a2], "delta_BA": round(a2 - b2, 4)}
        print("   %-22s 正序 A=%s B=%s Δ=%+.4f ｜ 反序 B=%s A=%s Δ(B→A 同向比较)=%+.4f"
              % (name, a, b, b - a, b2, a2, a2 - b2))
    res["tests"]["reversed"] = rev

    # ---- ③ 同历史、只改 trust：隔离 state 轴 ----------------------------
    print("\n③ 同历史（dh 内容一致）只改 trust：隔离「当前关系」轴")
    ladder = {}
    for t in (10, 30, 50, 70, 90):
        rel = {"trust": t, "respect": 45, "doubt": 30, "reliance": 10}
        v = tv(TEXT, rel, DH_EMPTY)
        ladder[t] = v
        print("   trust=%-3d → trust_shift=%.4f" % (t, v))
    xs = sorted(ladder)
    ys = [ladder[k] for k in xs]
    mono = all(ys[i] <= ys[i + 1] for i in range(len(ys) - 1))
    span = max(ys) - min(ys)
    print("   单调非降=%s ｜ 全跨度=%.4f （噪声底 0.05）" % (mono, span))
    res["tests"]["trust_ladder"] = ladder
    res["tests"]["trust_ladder_span"] = round(span, 4)
    res["tests"]["trust_ladder_monotonic"] = mono

    # ---- ④ 同 trust、只改历史内容：隔离 history 轴 ----------------------
    print("\n④ 同 trust=55，只改 dh 内容：隔离「历史证据」轴")
    REL_MID = {"trust": 55, "respect": 50, "doubt": 40, "reliance": 25}
    hist = {}
    for tag, dh in (("empty", DH_EMPTY), ("helped", DH_HELP), ("betrayed", DH_BETRAY),
                    ("betray_x3", DH_BETRAY * 3), ("helped_x3", DH_HELP * 3)):
        v = tv(TEXT, REL_MID, dh)
        hist[tag] = v
        print("   dh=%-10s (%d 条) → trust_shift=%.4f" % (tag, len(dh), v))
    vals = list(hist.values())
    print("   全跨度=%.4f （噪声底 0.05）" % (max(vals) - min(vals)))
    res["tests"]["history_isolated"] = hist

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    io.open(OUT, "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
    print("\n已写入 %s" % os.path.relpath(OUT, ROOT))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
