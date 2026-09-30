"""Phase3 P2.5 —— trust_shift 上下文敏感性专项实验。

要回答的**唯一**问题：
    在固定检查点、固定输入的前提下，`trust_shift` 是否不只区分「不同句子」，
    还会随 NPC **已知的上下文**（当前关系 / 既往历史）产生方向合理、可复现的变化？

为什么需要单独一轮（不能拿现有 contextual.json 的结论代替）：
    · 现有 contextual.json 断言的是多 signal 符号，48 条里**没有一条**断言 trust_shift
      —— 查 tests/ckpt_replication.json 的 rows.trust_shift 可确认 ctx_signed_med /
      ctx_sign_rate 全是 null、ctx_grades 为空。也就是说「trust_shift 对上下文不敏感」
      这件事**从来没被测过**，不能靠「P1 里它判别力 A 级」外推。
    · trust_shift 是唯一跨检查点稳定的 A 级 signal（td 0.827 / en 0.807），
      是 P3 State Transition 的首个验证对象 —— 让它带着一个未测的假设进 P3 不行。

本脚本**不改**任何东西：
    · 不改 narra_config.json（问题定义、评分规则、阈值全冻结）
    · 不改 capability grading（等级仍读 signalmetrics 已算好的值，本脚本不重算）
    · 不修模型、不调阈值

★ 两条既有通道，不新增第三种：
    axis=state   —— 改 relationship.trust（「当前状态」：NPC 现在的信任底色）
    axis=history —— 改 decision_history（「历史证据」：近期实际发生过什么）
    单变量优先：先分别验证两条轴各自是否被读到，再谈交互。

用法：
    ./.venv-cuda/Scripts/python.exe tests/replication/trust_context_probe.py
    LAYA_MODEL=english ./.venv-cuda/Scripts/python.exe tests/replication/trust_context_probe.py
"""
import hashlib
import io
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
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]

import laya_bridge as B  # noqa: E402

CASES_PATH = os.path.join(ROOT, "tests", "cases", "trust_context.json")
OUT_DIR = os.path.join(ROOT, "tests", "runs")
NOISE_FLOOR = 0.05


def sha_file(p):
    if not os.path.exists(p):
        return None
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def main():
    model = B.DEFAULT_MODEL_NAME
    blob = json.load(io.open(CASES_PATH, encoding="utf-8"))
    cases = blob["cases"]

    # ---- 输入冻结：全部哈希先取好，跑完再核对 ---------------------------
    # ★ 为什么必须现在就记：P2 那次「假告警」和 09-23 那次「跑次波动 0.073」的根因
    #   都是**条件在途中变了而没人发现**。哈希是让「条件没变」变成事实而不是假设。
    ds_sha = sha_file(CASES_PATH)
    cfg_sha = B._config_fingerprint()["sha"]
    cache_before = sha_file(str(B._XLATE_DISK))
    code_sha = B._code_fingerprint()

    print("=" * 92)
    print("P2.5 trust_shift 上下文敏感性 ｜ 检查点=%s ｜ 设备=%s" % (model, B.ENGINE.device_label()))
    print("用例集 %s ｜ sha=%s" % (os.path.basename(CASES_PATH), (ds_sha or "")[:16]))
    print("config sha=%s ｜ code sha=%s ｜ cache sha=%s"
          % (cfg_sha[:16], code_sha["sha"][:16], (cache_before or "")[:16]))
    print("=" * 92)

    B.ENGINE.init()
    if not B.ENGINE.ready:
        print("laya 未就绪，先跑 probe 看原因。")
        return 1

    # ---- 翻译缓存：开跑前必须完备，缺一条就拒绝执行 ----------------------
    # 与 signalmetrics 同口径（那条防线在 09-23 混条件事故之后加的，别绕过它）。
    cache = {}
    try:
        cache = json.loads(B._XLATE_DISK.read_text(encoding="utf-8"))
    except Exception:
        pass
    if B.LANG == "en":
        need = []
        for c in cases:
            if c["text"] not in need:
                need.append(c["text"])
        miss = [t for t in need if t not in cache]
        if miss:
            print("★ 开跑前检查未通过：%d 条输入不在翻译缓存里，拒绝开跑。" % len(miss))
            print("  先跑：./.venv-cuda/Scripts/python.exe tests/replication/prewarm_cache.py")
            for t in miss[:6]:
                print("     · %s" % t[:46])
            return 2
        print("翻译缓存完备：本集 %d 条输入全部命中" % len(need))

    qs = B.build_laya_questions(B.CFG["questions"])
    actor0 = json.loads(json.dumps(B.CFG["actor"]))   # 深拷贝，逐 pair 再改

    def make_doc(text, relationship, dh):
        """按 pair 的状态构造 state 文档。**只改** relationship 与 decision_history。"""
        actor = json.loads(json.dumps(actor0))
        if relationship:
            actor["relationship"] = dict(relationship)
        text_en = B._cached_translate(text, cache) if B.LANG == "en" else text
        return B.build_state_doc(actor, text, [], B.CFG.get("scene"), None,
                                 player_input_en=text_en, decision_history=dh)

    def run_tv(text, relationship, dh):
        """返回 trust_shift 的 score 期望值（0~4）。"""
        doc = make_doc(text, relationship, dh)
        _, _, by_name = B._run_signals(model, doc, qs)
        row = by_name.get("trust_shift")
        return None if row is None else float(row["value"])

    rows, problems = [], []

    for c in cases:
        cid = c["id"]
        # 输入有效性：溢出会让模型**看不到** message，那不是「它对输入的看法」
        b = B.state_budget(make_doc(c["text"], c["A"].get("relationship"), c["A"].get("decision_history")))
        b2 = B.state_budget(make_doc(c["text"], c["B"].get("relationship"), c["B"].get("decision_history")))
        ov = [x for x in (b, b2) if x and x.get("overflow")]
        if ov:
            problems.append("%s：state 溢出（room=%s），A/B 态之一被截断，结论不成立"
                            % (cid, ov[0].get("room")))
            continue

        try:
            va = run_tv(c["text"], c["A"].get("relationship"), c["A"].get("decision_history") or [])
            vb = run_tv(c["text"], c["B"].get("relationship"), c["B"].get("decision_history") or [])
        except Exception as e:
            problems.append("%s：运行失败 %r" % (cid, e))
            continue
        if va is None or vb is None:
            problems.append("%s：trust_shift 未返回值" % cid)
            continue

        spec = (c.get("expect") or {}).get("trust_shift") or {}
        delta = vb - va                      # B - A
        kind = spec.get("kind", "flip")

        row = {
            "id": cid, "family": c.get("family"), "axis": c.get("axis"),
            "kind": kind,
            "A": {"label": c["A"].get("label"), "trust_shift": round(va, 4)},
            "B": {"label": c["B"].get("label"), "trust_shift": round(vb, 4)},
            "delta": round(delta, 4),
            "beyond_noise": abs(delta) >= NOISE_FLOOR,
            "why": spec.get("why"),
        }

        if kind == "flip":
            # 定向判据：B-A 的符号应与 (B_sign - A_sign) 一致。
            # 两个端点都断言，而不是只断言「有变化」—— 只报 |Δ|>0 会把抖动当能力。
            want = spec["B_sign"] - spec["A_sign"]      # +2 或 -2，符号即期望方向
            signed = delta if want > 0 else -delta
            row.update({"want_A": spec["A_sign"], "want_B": spec["B_sign"],
                        "want_signed": (1 if want > 0 else -1),
                        "signed_delta": round(signed, 4),
                        "A_ok": (va < 2.0) if spec["A_sign"] < 0 else (va > 2.0),
                        "B_ok": (vb > 2.0) if spec["B_sign"] > 0 else (vb < 2.0),
                        "signed_ok": signed > 0,
                        "counts_toward": "direction"})
        elif kind == "attenuate":
            # 方向一致、幅度减弱。
            # ★ 判据必须是「B 离中立更近」而不是「Δ 的符号」：
            #   Δ = B - A，若 A=3.5、B=2.6（都偏正但 B 更弱），Δ = -0.9 是**负**的，
            #   而期望方向明明是正。用 Δ 的符号判会把「正确减弱」误判成「方向错了」。
            #   所以这里比较的是**离中立点 2.0 的距离**：B 更近 = 减弱成立。
            row.update({"want_signed": 1,
                        "A_ok": va > 2.0, "B_ok": vb > 2.0,
                        "signed_delta": round(delta, 4),
                        "counts_toward": "attenuation"})
            row["A_dist"] = round(abs(va - 2.0), 4)
            row["B_dist"] = round(abs(vb - 2.0), 4)
            row["attenuated"] = row["B_dist"] < row["A_dist"]
            row["signed_ok"] = row["attenuated"]
        else:
            row.update({"counts_toward": "mechanism_only"})

        rows.append(row)
        print("  [%-34s] A=%.3f → B=%.3f  Δ=%+.3f %s"
              % (cid, va, vb, delta, "★越噪" if row["beyond_noise"] else ""))

    # ---- 汇总 -----------------------------------------------------------
    def agg(sel, label):
        n = len(sel)
        if not n:
            return None
        signed = [r["signed_delta"] for r in sel if r.get("signed_delta") is not None]
        d = [r["delta"] for r in sel]
        ok = sum(1 for r in sel if r.get("signed_ok"))
        srt = sorted(signed)
        med = (srt[len(srt) // 2] if len(srt) % 2
               else (srt[len(srt) // 2 - 1] + srt[len(srt) // 2]) / 2.0)
        return {"label": label, "n": n, "sign_rate": round(ok / n, 4), "sign_ok": ok,
                "mean_signed": round(sum(signed) / len(signed), 4) if signed else None,
                "median_signed": round(med, 4) if signed else None,
                "mean_abs_delta": round(sum(abs(x) for x in d) / n, 4),
                "n_beyond_noise": sum(1 for r in sel if r["beyond_noise"]),
                "ids": [r["id"] for r in sel]}

    directional = [r for r in rows if r["counts_toward"] == "direction"]
    attenuated = [r for r in rows if r["counts_toward"] == "attenuation"]
    state_only = [r for r in directional if r["axis"] == "state"]
    history_only = [r for r in directional if r["axis"] == "history"]
    interaction = [r for r in rows if r["counts_toward"] == "mechanism_only"]

    summary = {
        "directional_all": agg(directional, "全部定向 pair（flip）"),
        "axis_state": agg(state_only, "通道=当前关系（单变量）"),
        "axis_history": agg(history_only, "通道=历史证据（单变量）"),
        "attenuation": agg(attenuated, "减弱型 pair（方向一致）"),
    }

    print("\n" + "-" * 92)
    print("── 定向正确率 / effect size " + "-" * 60)
    print("  %-30s %4s %10s %12s %12s %10s"
          % ("分组", "n", "定向正确", "均Δ(定向)", "中位Δ(定向)", "均|Δ|"))
    for k in ("directional_all", "axis_state", "axis_history", "attenuation"):
        s = summary[k]
        if not s:
            print("  %-30s %4d %10s" % (k, 0, "无样本"))
            continue
        print("  %-30s %4d %7d/%-3d %11s %12s %10.3f"
              % (s["label"], s["n"], s["sign_ok"], s["n"],
                 ("%+.3f" % s["mean_signed"]) if s["mean_signed"] is not None else "-",
                 ("%+.3f" % s["median_signed"]) if s["median_signed"] is not None else "-",
                 s["mean_abs_delta"]))

    for r in attenuated:
        print("  减弱型 %-32s A距中立 %.3f → B距中立 %.3f ｜ %s"
              % (r["id"], r["A_dist"], r["B_dist"], "已减弱" if r["attenuated"] else "未减弱"))
    for r in interaction:
        print("  交互   %-32s Δ=%+.3f（仅解释机制，不单独判通过）" % (r["id"], r["delta"]))

    # ---- 逐 pair 明细（含「为什么预期如此」）-----------------------------
    print("\n── 逐 pair 明细 " + "-" * 74)
    for r in rows:
        print("  [%s] %s / %s" % (r["id"], r["family"], r["axis"]))
        print("     A %-28s trust_shift=%.3f" % (r["A"]["label"], r["A"]["trust_shift"]))
        print("     B %-28s trust_shift=%.3f" % (r["B"]["label"], r["B"]["trust_shift"]))
        print("     Δ(B-A)=%+.3f ｜ %s" % (r["delta"], r["counts_toward"]))
        print("     预期理由：%s" % (r["why"] or "")[:200])

    # ---- 跑后核对：条件是否真的没变 --------------------------------------
    cache_after = sha_file(str(B._XLATE_DISK))
    cfg_after = B._config_fingerprint()["sha"]
    validity = {
        "dataset_sha": ds_sha,
        "config_sha": cfg_sha,
        "config_sha_after": cfg_after,
        "config_unchanged": cfg_sha == cfg_after,
        "code_sha": code_sha["sha"],
        "cache_sha_before": cache_before,
        "cache_sha_after": cache_after,
        # ★ cache 在 en 模式下跑完**可能**变大（本集新文本在预热后被写入）。
        #   这不是「条件变了」——变的是缓存文件，不是本集输入的译文。
        #   真正该冻结的是本集输入的译文集合，故单独再算一份子集哈希。
        "subset_sha_after": B._xlate_subset_fingerprint()["sha"],
        "n_cases": len(cases), "n_rows_ok": len(rows), "problems": problems,
    }
    print("\n条件核对：config 未变=%s ｜ 缓存 sha 前=%s 后=%s"
          % (validity["config_unchanged"], (cache_before or "")[:12], (cache_after or "")[:12]))
    if problems:
        print("★ 问题 %d 项：" % len(problems))
        for p in problems:
            print("   · %s" % p)

    out = {
        "_readme": [
            "P2.5 trust_shift 上下文敏感性原始结果。",
            "checkpoint=%s ｜ 每态只跑一次（模型在固定输入下已确认 deterministic，见 §16 方法论更正）。" % model,
            "本文件只测 trust_shift，不改问题定义/评分规则/阈值/能力档案。",
        ],
        "checkpoint": model,
        "cases_sha": ds_sha,
        "validity": validity,
        "summary": summary,
        "rows": rows,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = "trust_context__%s.json" % model
    with io.open(os.path.join(OUT_DIR, tag), "w", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=1))
    print("\n已写入 tests/runs/%s" % tag)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
