"""取「中性台词」在三个场景下的 raw `trust_shift` score（0~4），并做 ×3 复现性检查。

为什么单独有这个脚本（而不是只看体验测试的最终 trust 值）：
    体验测试报的是「trust 累计变化」，它把**模型输出**和**State Transition 的截断**
    和**多轮累积**揉在一个数里。当 E3 未过时，只看那个数无法区分三种完全不同的原因：

      ① 模型把中性话读成负向（模型偏差）
      ② 某一轮模型给出极端值（个别输入异常）
      ③ 多轮小幅同向累积（结构性漂移）

    这三种的处理方式完全不同，所以必须回到**单轮 raw score** —— 它是模型对
    「这一句造成多少信任变化」的直接读数，不含任何状态层影响。

    判据刻度：score 是 0~4 的期望值，中点 2.0 = 「trust is unchanged」。
      > 2.0 → 读成正向；< 2.0 → 读成负向；= 2.0 → 中性。
      ★ 注意这不是"通过/不通过"判据，是一个**读数工具**，所以它不做断言。

用法：
    LAYA_DEVICE=cuda ./.venv-cuda/Scripts/python.exe tests/replication/neutral_probe.py
    LAYA_DEVICE=cuda ./.venv-cuda/Scripts/python.exe tests/replication/neutral_probe.py --json
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
    raise SystemExit("找不到 laya_bridge.py；脚本必须放在 laya-live/ 之内")


ROOT = _find_root(HERE)
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

import laya_bridge as B  # noqa: E402

CASES = os.path.join(ROOT, "tests", "cases", "p3_experience.json")
OUT = os.path.join(ROOT, "tests", "runs")
REPEATS = 3


def main():
    want_json = "--json" in sys.argv
    blob = json.load(io.open(CASES, encoding="utf-8"))
    scs = [s for s in blob["scenarios"]
           if s["id"] in ("e1_positive", "e2_negative", "e3_neutral")]
    cache = json.load(io.open(B._XLATE_DISK, encoding="utf-8"))

    B.ENGINE.init()
    if not B.ENGINE.ready:
        print("laya 未就绪：%s" % B.ENGINE.describe())
        return 1

    model = B.DEFAULT_MODEL_NAME
    qs = B.build_laya_questions(B.CFG["questions"])
    actor = B.CFG["actor"]
    neutral_point = 2.0

    print("=" * 100)
    print("raw trust_shift score 读数 ｜ 检查点=%s ｜ 设备=%s" % (model, B.ENGINE.device_label()))
    print("刻度：0~4 期望值，中点 %.1f = 「trust is unchanged」。> %.1f 读成正向，< %.1f 读成负向"
          % (neutral_point, neutral_point, neutral_point))
    print("=" * 100)

    out = {"checkpoint": model, "device": B.ENGINE.device_label(),
           "scale": {"min": 0, "max": 4, "neutral": neutral_point},
           "repeats": REPEATS, "groups": {}}

    for s in scs:
        g = {"desc": s["desc"], "rows": []}
        print("\n[%s] %s" % (s["id"], s["desc"]))
        for t in s["lines"]:
            vals = []
            for _ in range(REPEATS):
                doc = B.build_state_doc(actor, t, [], B.CFG.get("scene"), None,
                                        player_input_en=cache.get(t, t), decision_history=[])
                _, _, bn = B._run_signals(model, doc, qs)
                r = bn.get("trust_shift")
                vals.append(round(float(r["value"]), 4) if r else None)
            uniq = sorted(set(v for v in vals if v is not None))
            deterministic = len(uniq) == 1
            v = uniq[0] if uniq else None
            g["rows"].append({
                "text_zh": t, "text_en": cache.get(t, t),
                "scores": vals, "score": v,
                "deterministic": deterministic,
                "vs_neutral": (round(v - neutral_point, 4) if v is not None else None),
                "reading": ("正向" if (v is not None and v > neutral_point) else
                            ("负向" if v is not None else "无值")),
            })
            print("   score=%-7s (×%d: %s) %-9s | %-44s | %s"
                  % (v, REPEATS, "一致" if deterministic else "★不一致",
                     g["rows"][-1]["reading"],
                     (cache.get(t, t))[:43], t[:16]))
        out["groups"][s["id"]] = g

    # ---- 汇总：三组的分布位置 -------------------------------------------
    print("\n" + "-" * 100)
    print("三组相对中立点 %.1f 的位置" % neutral_point)
    summary = {}
    for gid, g in out["groups"].items():
        vs = [r["score"] for r in g["rows"] if r["score"] is not None]
        if not vs:
            continue
        n_pos = sum(1 for v in vs if v > neutral_point)
        n_neg = sum(1 for v in vs if v < neutral_point)
        summary[gid] = {
            "min": round(min(vs), 4), "max": round(max(vs), 4),
            "mean": round(sum(vs) / len(vs), 4),
            "span": round(max(vs) - min(vs), 4),
            "n_positive": n_pos, "n_negative": n_neg, "n": len(vs),
            "all_deterministic": all(r["deterministic"] for r in g["rows"]),
        }
        print("  %-14s min=%.3f max=%.3f mean=%.3f span=%.3f ｜ 正向 %d/%d 负向 %d/%d ｜ 逐句 ×%d 一致=%s"
              % (gid, summary[gid]["min"], summary[gid]["max"], summary[gid]["mean"],
                 summary[gid]["span"], n_pos, len(vs), n_neg, len(vs),
                 REPEATS, summary[gid]["all_deterministic"]))
    out["summary"] = summary

    n = out["groups"]["e3_neutral"]["rows"]
    e3 = summary.get("e3_neutral") or {}
    print("\n── 中性组的解释 " + "-" * 80)
    if e3:
        if e3["n_negative"] >= len(n) * 0.6:
            print("  ★ 中性组 %d/%d 句被读成**负向**（mean=%.3f < %.1f）→ 属**系统性偏负**，"
                  "不是偶发抖动。" % (e3["n_negative"], e3["n"], e3["mean"], neutral_point))
            print("    这是模型的读数特征（中性寒暄被当作轻微损害信任），"
                  "与状态层无关 —— raw score 不含任何状态层影响。")
        elif e3["n_negative"] == 0:
            print("  中性组无负向读数（mean=%.3f）→ 无系统性偏负。" % e3["mean"])
        else:
            print("  中性组 %d/%d 负向（mean=%.3f）→ 方向不一致，更接近抖动。"
                  % (e3["n_negative"], e3["n"], e3["mean"]))

    os.makedirs(OUT, exist_ok=True)
    tag = "neutral_probe__%s.json" % model
    io.open(os.path.join(OUT, tag), "w", encoding="utf-8").write(
        json.dumps(out, ensure_ascii=False, indent=1))
    print("\n已写入 tests/runs/%s" % tag)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
