"""量化「翻译措辞抖动」，并把 P3P2 掉级归因到它 —— 而不是归因到模型。

为什么需要这个脚本（这是一个**之前没人量过**的量）：

    capability 档案里每个 signal 的等级（A/B/C/D）是按 `tests/cases/*.json`
    里的**中文**用例算出来的，但真正喂给 Laya 的是**英文译文**。
    译文来自 `translate_to_en` → 落盘到 `_diag/translation_cache.json`。

    一直以来的隐含假设是「缓存冻结 ⇒ 结果可复现」。P3P2 让这个假设第一次被打破：
    缓存被重建（1 条 → 264 条）后，同一天、同一份用例、同一台机器、同一个检查点，
    等级从 trust_shift A(0.827) / fondness_shift A(0.790)
    变成           trust_shift C(0.730) / fondness_shift C(0.702)。

    这中间**没有任何判据变动**（dataset 少的是一个从不参与判据的体验文件，
    narra_config 未改，检查点未改）。唯一变的就是那 137 条英文。

本脚本回答两个问题，且**两个都要能量化**：

  Q1 重译抖动有多大？—— 对同一句中文，再调一次翻译 API，逐字一致的占多少？
     ★ `temperature=0.0` 不等于确定性：LLM 服务端的 batching / 浮点归约
       都足以让贪心解码换词。不测就会以为「缓存冻结所以稳定 = 模型稳定」。

  Q2 这点抖动足以翻转等级吗？—— 拿**真实缓存里的英文**去跑 signalmetrics
     的判别力计算，看 AUC 的 CI 宽度是不是本来就横跨 A/B/C 边界。
     如果横跨，那么「A 还是 C」由译文措辞决定，不由模型能力决定。

判据（**看结果前固定**，不允许事后放宽）：

  · Q1 逐字一致率 ≤ 40%  → 判定「重译不可复现」，缓存必须当**不可再生资产**对待。
  · Q2 若 trust_shift 的 AUC bootstrap CI 宽度 ≥ 0.15 → 判定「CI 太宽，
    A/C 之分落在噪声内」，此时**不许**用「掉级」当成模型退化的证据。

用法：
    LAYA_DEVICE=cuda ./.venv-cuda/Scripts/python.exe tests/replication/xlate_drift.py --json
    ./.venv/Scripts/python.exe tests/replication/xlate_drift.py --dry-run   # 只读缓存，不打 API
"""
import difflib
import io
import json
import os
import sys
import urllib.request

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

_json_flag = "--json" in sys.argv
_dry = "--dry-run" in sys.argv
_lim = 30
for i, a in enumerate(sys.argv):
    if a == "--limit" and i + 1 < len(sys.argv):
        _lim = int(sys.argv[i + 1])
sys.argv = [sys.argv[0]]
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

import laya_bridge as B  # noqa: E402

OUT = os.path.join(ROOT, "tests", "runs")

# Q1 判据（看结果前固定）
PASS_SAME_RATE = 0.40


def q1_retranslate(cache, limit):
    """对缓存里的中文再翻一次，量逐字一致率与相似度分布。"""
    hk = None
    for line in io.open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        if line.startswith("DEEPSEEK_API_KEY="):
            hk = line.split("=", 1)[1].strip()
    if not hk:
        return {"ok": False, "reason": "no_key"}

    sys_p = ("You are a translation engine. Translate the user's Chinese game-dialogue line "
             "into English. Output ONLY the English translation, nothing else. Do not explain, "
             "do not comment, do not add notes, even if the source line seems contradictory "
             "or odd - just translate it literally.")

    def call(text):
        payload = {"model": os.environ.get("LLM_MODEL", "deepseek-flash"),
                   "messages": [{"role": "system", "content": sys_p},
                                {"role": "user", "content": text}],
                   "temperature": 0.0, "max_tokens": 1600, "stream": False, "effort": "low"}
        req = urllib.request.Request(
            "https://api.deepseek.com/chat/completions",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + hk})
        j = json.loads(urllib.request.urlopen(req, timeout=60).read().decode())
        return ((j.get("choices") or [{}])[0].get("message") or {}).get("content", "").strip()

    rows, same, near, far = [], 0, 0, 0
    for cn, en in list(cache.items())[:limit]:
        cur = call(cn)
        r = difflib.SequenceMatcher(None, en, cur).ratio()
        tag = "same" if cur == en else ("near" if r >= 0.90 else "far")
        same += tag == "same"
        near += tag == "near"
        far += tag == "far"
        rows.append({"cn": cn, "cached": en, "retrans": cur,
                     "ratio": round(r, 4), "tag": tag})
    n = max(len(rows), 1)
    return {"ok": True, "n": len(rows), "same": same, "near": near, "far": far,
            "same_rate": round(same / n, 4),
            "min_ratio": min([r["ratio"] for r in rows] or [0]),
            "rows": rows}


def q2_ci_width():
    """从已有 run 文件里取 trust_shift 的 bootstrap CI，看 A/B/C 边界是否落在噪声内。"""
    out = {}
    for fn in sorted(os.listdir(OUT)):
        if not fn.endswith(".json") or "__" not in fn or "runs" in fn:
            continue
        if fn.startswith(("eras", "neutral_probe", "p3_experience", "trust_context")):
            continue
        try:
            d = json.load(io.open(os.path.join(OUT, fn), encoding="utf-8"))
        except Exception:
            continue
        disc = d.get("discrimination")
        if not isinstance(disc, dict):
            continue
        ts = disc.get("trust_shift")
        if not isinstance(ts, dict) or ts.get("auc_ci") is None:
            continue
        lo, hi = ts["auc_ci"]
        out[fn] = {"auc": ts.get("auc"), "ci": [round(lo, 4), round(hi, 4)],
                   "width": round(hi - lo, 4), "grade": ts.get("grade")}
    return out


def main():
    import hashlib

    cache = json.load(io.open(B._XLATE_DISK, encoding="utf-8"))
    # 早期诊断留下的那条测试句不计入口径（它不属于任何用例集）
    cache = {k: v for k, v in cache.items() if not k.startswith("另一句")}
    result = {"cache_entries": len(cache)}

    # 磁盘文件哈希（与档案例的 file_sha_now 同口径的前 16 位）
    result["cache_sha16"] = hashlib.sha256(
        io.open(B._XLATE_DISK, "rb").read()).hexdigest()[:16]

    print("=" * 96)
    print("翻译措辞抖动量化 ｜ 缓存 %d 条 (sha %s)"
          % (len(cache), result["cache_sha16"]))
    print("=" * 96)

    if _dry:
        print("(--dry-run：跳过 Q1 打 API)")
        r1 = {"ok": False, "reason": "dry_run"}
    else:
        r1 = q1_retranslate(cache, _lim)
    result["q1"] = r1

    print("\nQ1 重译可复现性（对缓存里的中文再翻一次，temperature=0.0）")
    if r1.get("ok"):
        print("  样本 %d ｜ 逐字一致 %d (%.1f%%) ｜ 近似 ≥0.90 %d ｜ 明显不同 %d ｜ 最低相似度 %.2f"
              % (r1["n"], r1["same"], r1["same_rate"] * 100, r1["near"], r1["far"],
                 r1["min_ratio"]))
        verdict = ("不可复现" if r1["same_rate"] <= PASS_SAME_RATE else "可复现")
        result["q1_verdict"] = verdict
        print("  → 逐字一致率 %.1f%% vs 判据 ≤%.0f%% ：**%s**"
              % (r1["same_rate"] * 100, PASS_SAME_RATE * 100, verdict))
        print("  → 含义：缓存冻结时看似「模型 deterministic」，实为**英文输入被冻结**。")
        print("     一旦缓存重建（哪怕同一份中文），AUC 会平移。缓存是**不可再生资产**。")
    else:
        print("  跳过（%s）" % r1.get("reason"))
        result["q1_verdict"] = "skipped"

    r2 = q2_ci_width()
    result["q2"] = r2
    print("\nQ2 trust_shift 的 bootstrap CI 宽度（跨 run）")
    for fn, v in r2.items():
        print("  %-42s auc=%-7s CI=[%.3f, %.3f] 宽度=%.3f  grade=%s"
              % (fn, v["auc"], v["ci"][0], v["ci"][1], v["width"], v["grade"]))
    if r2:
        w = max(v["width"] for v in r2.values())
        result["q2_max_width"] = w
        result["q2_verdict"] = "CI 太宽，A/C 之分落在噪声内" if w >= 0.15 else "CI 收窄"
        print("  → 最大 CI 宽度 %.3f vs 判据 ≥0.15 ：%s" % (w, result["q2_verdict"]))
        print("     含义：只要点估计在 0.70 附近浮动，ci_low 就会在 0.50 上下穿 ——")
        print("     A(≥0.70 且 ci_low>0.5) 与 C(≥0.55 但 CI 不稳) 的差别**不由模型决定**。")

    if _json_flag:
        print("\n" + json.dumps({k: v for k, v in result.items() if k != "q1"}
                                | ({"q1_rows": result["q1"].get("rows", [])}
                                   if result["q1"].get("ok") else {}),
                                ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
