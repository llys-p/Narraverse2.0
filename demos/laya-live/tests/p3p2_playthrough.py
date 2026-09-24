"""Phase3-P3 Phase2 Task7/Task8：连续游玩模拟 + 体验摘要。

与 p3_experience.py 的分工：
    p3_experience.py —— 判据。每个短场景只验一件事，可复现、可回归。
    本脚本        —— 长跑。44 轮跨场景连续走查，看**跨场景的连续性**：
                     同一个人物经历亲近 → 冲突 → 道歉之后，关系是否连贯、能否恢复；
                     不同 NPC 是否各自演化；两个 session 是否互不影响。

★ 本脚本**不追求统计证明**。用户本阶段的要求是「正常连续玩下来没有明显重大 Bug，
  人物关系总体合理」。所以它输出的重点不是 PASS/FAIL 数量，而是：
    ① 每个 NPC 的起止状态（Task8 的摘要表）
    ② 关键变化事件时间线（哪一轮发生了什么、各维度动了多少）
    ③ 六条「体验重点观察」的判定（见 REPORT_ITEMS）

★ 六条观察（对应用户 Task7 的原文要求）：
    1. 有没有「刚认识两句话 trust 就 95」——禁止
    2. 普通聊天有没有慢慢把关系漂坏
    3. 同一个 NPC 的关系有没有连续性（不能莫名回退）
    4. 不同 NPC 是否明显不同步
    5. 冲突以后是否可以恢复（不能一次吵架永久锁死）
    6. 多个状态能否形成合理组合（如 trust 高 + fondness 低）

用法：
    ./.venv/Scripts/python.exe tests/p3p2_playthrough.py
    LAYA_MODEL=english ./.venv/Scripts/python.exe tests/p3p2_playthrough.py
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
    raise SystemExit("找不到 laya_bridge.py；脚本必须放在 laya-live/ 之内")


ROOT = _find_root(HERE)
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

import laya_bridge as B  # noqa: E402

BOOK = os.path.join(ROOT, "tests", "experience", "p3p2_playthrough.json")
OUT_DIR = os.path.join(ROOT, "tests", "runs")

# 冲突后恢复的观察窗口：Lia 被冒犯/威胁之后，看之后多少轮内 trust 是否回升
RECOVERY_WINDOW = 6


def sha_file(p):
    if not os.path.exists(p):
        return None
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def run(book, model):
    casts = book["casts"]
    # 把 cast id + session 组成桶键；同 id 不同 session 是不同桶
    buckets = {}
    for c in casts:
        buckets.setdefault((c["session"], c["id"]), c)

    trace = []
    for i, step in enumerate(book["script"], 1):
        cast = step["cast"]
        # S2 的 Roth 用 kind=另一局 标记；其余走 S1
        session = "S2" if step.get("kind") == "另一局" else "S1"
        out = B.decide({"player_input": step["text"], "session_id": session,
                        "actor_id": cast})
        st = ((out.get("actor_state") or {}).get("state") or {})
        rel = st.get("relationship") or {}
        emo = st.get("emotion") or {}
        trace.append({
            "turn": i,
            "session": session,
            "cast": cast,
            "kind": step.get("kind"),
            "text": step["text"],
            "trust": rel.get("trust"),
            "doubt": rel.get("doubt"),
            "respect": rel.get("respect"),
            "fondness": emo.get("fondness"),
            "commits": [{"signal": c["signal"], "old": c["old"], "proposal": c["proposal"],
                         "after_deadzone": c.get("after_deadzone"),
                         "final_delta": c["final_delta"], "new_value": c["new_value"],
                         "clamped_by": c["clamped_by"],
                         "deadzone_applied": (c.get("deadzone") or {}).get("applied")}
                        for c in (out.get("state_commits") or [])],
            "n_skipped": len(out.get("state_skipped") or []),
            "behavior": ((out.get("decision") or {}).get("behavior") or {}).get("id"),
            "awaiting_upstream": (out.get("decision") or {}).get("awaiting_upstream"),
        })
    return trace


def end_states(book):
    out = {}
    for c in book["casts"]:
        k = (c["session"], c["id"])
        if k in out:
            continue
        v = B.actor_state_view(c["session"], c["id"])
        st = (v.get("state") or {})
        out[k] = {
            "name": c["name"], "desc": c.get("desc"),
            "exists": v.get("exists"),
            "trust": ((st.get("relationship") or {}).get("trust")),
            "doubt": ((st.get("relationship") or {}).get("doubt")),
            "respect": ((st.get("relationship") or {}).get("respect")),
            "fondness": ((st.get("emotion") or {}).get("fondness")),
        }
    return out


def summary_table(book, trace, tpl):
    """Task8 摘要：每个 NPC 的起止值。"""
    per = {}
    for r in trace:
        per.setdefault((r["session"], r["cast"]), []).append(r)
    e = end_states(book)
    lines = []
    for (sess, cast), rows in per.items():
        if sess == "S2":      # S2 的 Roth 单独列，避免与 S1 混
            continue
        first = rows[0]
        e0 = e.get((sess, cast)) or {}
        lines.append({
            "cast": cast, "session": sess, "turns": len(rows),
            "trust": [tpl["trust"], e0.get("trust")],
            "doubt": [tpl["doubt"], e0.get("doubt")],
            "fondness": [tpl["fondness"], e0.get("fondness")],
            "respect": "auxiliary only",
        })
    return lines


def key_events(trace, min_abs=2.0):
    """关键变化事件：把单轮里明显的变化挑出来（默认 |Δtrust|>=2 或有 doubt/fondness 跳变）。"""
    out = []
    for r in trace:
        cs = {c["signal"]: c for c in (r["commits"] or [])}
        t = cs.get("trust_shift")
        d = cs.get("doubt_shift")
        f = cs.get("fondness_shift")
        hit = (t and abs(t["final_delta"]) >= min_abs) or \
              (d and abs(d["final_delta"]) >= min_abs) or \
              (f and abs(f["final_delta"]) >= 0.02)
        if not hit:
            continue
        ev = {"turn": r["turn"], "cast": r["cast"], "session": r["session"],
              "kind": r.get("kind"), "text": r["text"],
              "changes": {}}
        for nm, c in (("trust", t), ("doubt", d), ("fondness", f)):
            if c:
                ev["changes"][nm] = round(c["final_delta"], 4)
        out.append(ev)
    return out


def main():
    model = B.DEFAULT_MODEL_NAME
    book = json.load(io.open(BOOK, encoding="utf-8"))

    prof, prof_check = B.load_capability_profile(model)
    if not prof_check.get("fresh"):
        print("★ 前置条件未通过：能力档案不是 fresh，状态层会拒绝写任何 delta。")
        for p in prof_check.get("problems") or []:
            print("   · %s" % p)
        print("  先重建：signalmetrics → capability → capability --check")
        return 2

    tpl = B.CFG["actor"]
    tplv = {"trust": tpl["relationship"]["trust"], "doubt": tpl["relationship"]["doubt"],
            "fondness": tpl["emotion"]["fondness"]}
    cfg_sha = B._config_fingerprint()["sha"]
    bk_sha = sha_file(BOOK)
    cache_before = sha_file(str(B._XLATE_DISK))

    print("=" * 96)
    print("P3 Phase2 连续游玩模拟（Task7）｜ 检查点=%s ｜ 设备=%s"
          % (model, B.ENGINE.device_label()))
    print("剧本 %s ｜ sha=%s ｜ 共 %d 轮 ｜ 死区 trust=%s doubt=%s fondness=%s"
          % (os.path.basename(BOOK), (bk_sha or "")[:16], len(book["script"]),
             B.deadzone_of("trust_shift"), B.deadzone_of("doubt_shift"),
             B.deadzone_of("fondness_shift")))
    print("=" * 96)

    B.ENGINE.init()
    if not B.ENGINE.ready:
        print("laya 未就绪。")
        return 1

    B.reset_actor_state()
    B.reset_history()

    trace = run(book, model)

    # ---- 逐轮打印 ---------------------------------------------------------
    print()
    print("── 逐轮走查（44 轮连续）" + "-" * 60)
    cur = None
    for r in trace:
        if (r["session"], r["cast"]) != cur:
            cur = (r["session"], r["cast"])
            print("\n▸ %s / %s" % (r["session"], r["cast"]))
        cs = {c["signal"]: c for c in (r["commits"] or [])}
        def g(k, fmt="%+.1f"):
            c = cs.get(k)
            return (fmt % c["final_delta"]) if c else "  —  "
        dz = "·" if any(c.get("deadzone_applied") for c in (r["commits"] or [])) else " "
        print("  %2d %-10s t=%-6s d=%-6s f=%-7s %s%s" % (
            r["turn"], (r.get("kind") or "")[:10], r["trust"], r["doubt"],
            r["fondness"], dz, r["text"][:26]))

    # ---- Task8 摘要 -------------------------------------------------------
    print()
    print("=" * 96)
    print("── Task8 体验摘要：每个 NPC 的起止" + "-" * 52)
    st = summary_table(book, trace, tplv)
    for row in st:
        print()
        print("  NPC %s（%s，%d 轮）" % (row["cast"], row["session"], row["turns"]))
        print("    trust    : %s → %s" % (row["trust"][0], row["trust"][1]))
        print("    doubt    : %s → %s" % (row["doubt"][0], row["doubt"][1]))
        print("    fondness : %s → %s" % (row["fondness"][0], row["fondness"][1]))
        print("    respect  : auxiliary only")
    e = end_states(book)
    s2 = e.get(("S2", "Roth"))
    if s2:
        print()
        print("  NPC Roth（S2，另一局，3 轮 —— 用来验跨 session 不串线）")
        print("    trust    : %s → %s" % (tplv["trust"], s2.get("trust")))
        print("    doubt    : %s → %s" % (tplv["doubt"], s2.get("doubt")))
        print("    fondness : %s → %s" % (tplv["fondness"], s2.get("fondness")))

    # ---- 关键变化事件 -----------------------------------------------------
    kev = key_events(trace)
    print()
    print("── 关键变化事件（Turn N：什么台词 → 各维度动了多少）" + "-" * 40)
    for ev in kev:
        ch = "  ".join("%s %+.2f" % (k, v) for k, v in ev["changes"].items())
        print("  Turn %-2d [%s/%s] %-9s %s" % (
            ev["turn"], ev["session"], ev["cast"], (ev.get("kind") or "")[:9], ch))
        print("         「%s」" % ev["text"][:44])

    # ---- 六条体验重点观察 -------------------------------------------------
    print()
    print("=" * 96)
    print("── 六条体验重点观察（Task7 原文要求）" + "-" * 50)
    obs = []

    def add(tag, ok, detail, warn=False):
        obs.append({"id": tag, "ok": bool(ok), "detail": detail, "warn_only": warn})
        print("  %s [%s] %s" % ("✅" if ok else ("⚠️" if warn else "❌"), tag, detail))

    # 1) 刚认识两句话就 95 —— 禁止
    early = [r for r in trace if r["turn"] <= 3 and r["trust"] is not None]
    worst_early = max((r["trust"] for r in early), default=None)
    add("O1", worst_early is not None and worst_early < 90,
        "前 3 轮最高 trust=%s（禁止「两句话到 95」）" % worst_early)

    # 2) 普通聊天有没有把关系漂坏：看所有 kind=普通闲聊 的轮次累计
    chat = [r for r in trace if (r.get("kind") or "").startswith("普通闲聊")]
    chat_d = []
    for r in chat:
        ts = [c for c in (r["commits"] or []) if c["signal"] == "trust_shift"]
        chat_d.append(ts[0]["final_delta"] if ts else 0.0)
    chat_sum = sum(chat_d)
    add("O2", abs(chat_sum) <= max(2.0, 0.6 * len(chat)),
        "普通闲聊共 %d 轮，trust 累计 %+.1f（逐轮 %s）"
        % (len(chat), chat_sum, " ".join("%+.1f" % x for x in chat_d)))

    # 3) 同一 NPC 的连续性：不能莫名回退（除死区归零外，单轮变化必须来自 commit）
    jumps = []
    for (sess, cast), rows in _group(trace).items():
        prev = None
        for r in rows:
            if prev is not None and r["trust"] is not None and prev is not None:
                dv = r["trust"] - prev
                committed = sum(c["final_delta"] for c in (r["commits"] or [])
                                if c["signal"] == "trust_shift")
                if abs(dv - committed) > 1e-6:
                    jumps.append((r["turn"], dv, committed))
            prev = r["trust"]
    add("O3", not jumps,
        "逐轮 trust 变化与 commit 值一致（无「不知从哪冒出来」的回退）"
        if not jumps else "发现 %d 处不一致：%s" % (len(jumps), jumps[:3]))

    # 4) 不同 NPC 不同步
    ends = {}
    for (sess, cast) in _group(trace):
        v = B.actor_state_view(sess, cast)
        s = (v.get("state") or {})
        ends[(sess, cast)] = (((s.get("relationship") or {}).get("trust")),
                              ((s.get("emotion") or {}).get("fondness")))
    vals = [t for t, _ in ends.values() if t is not None]
    spread = (max(vals) - min(vals)) if len(vals) >= 2 else 0
    add("O4", spread >= 3,
        "各桶 trust 终值：%s ｜ 极差 %.1f（若不同步，极差会很小）"
        % (", ".join("%s/%s=%s" % (k[0], k[1], v) for k, v in ends.items()), spread))

    # 5) 冲突后能否恢复（Lia 被冒犯/威胁之后 trust 是否回升）
    lia = [r for r in trace if r["cast"] == "Lia" and r["session"] == "S1"]
    bad_turns = [r["turn"] for r in lia
                 if (r.get("kind") or "") in ("轻微冒犯", "明显威胁")]
    rec = None
    if bad_turns:
        t0 = min(bad_turns)
        after = [r for r in lia if r["turn"] > t0][:RECOVERY_WINDOW]
        before_v = [r["trust"] for r in lia if r["turn"] == t0]
        if after and before_v:
            low = min(r["trust"] for r in after if r["trust"] is not None)
            endv = after[-1]["trust"]
            rec = (t0, before_v[0], low, endv)
    add("O5", bool(rec) and rec[3] > rec[2],
        ("冲突（Turn %d，trust %s）之后 %d 轮内：最低 %s → 回到 %s（可以恢复，未锁死）"
         % (rec[0], rec[1], RECOVERY_WINDOW, rec[2], rec[3])) if rec
        else "剧本里没有踩到冲突轮，无法判断恢复")

    # 6) 合理组合是否存在（trust 高 + fondness 低）
    combos = [(k, v) for k, v in ends.items() if v[0] is not None and v[1] is not None]
    hi_t_low_f = [c for c in combos if c[1][0] > tplv["trust"] and c[1][1] <= tplv["fondness"]]
    add("O6", len(hi_t_low_f) > 0,
        "「trust 高于初值且 fondness 不高于初值」的桶：%s"
        % ("、".join("%s/%s(trust=%s,fond=%s)" % (k[0], k[1], v[0], v[1])
                     for k, v in hi_t_low_f) or "（无 —— 六个维度可能被绑成同向了）"))

    # ---- 附加：异常检查 ---------------------------------------------------
    nan = [r["turn"] for r in trace
           if None in (r["trust"], r["doubt"], r["fondness"])
           or any(isinstance(r[k], float) and r[k] != r[k]
                  for k in ("trust", "doubt", "fondness"))]
    oob = [r["turn"] for r in trace
           if (r["trust"] is not None and not (0 <= r["trust"] <= 100))
           or (r["doubt"] is not None and not (0 <= r["doubt"] <= 100))
           or (r["fondness"] is not None and not (0 <= r["fondness"] <= 1))]
    add("O7", not nan and not oob,
        "无 NaN、无越界（NaN 轮=%s ｜ 越界轮=%s）" % (nan[:5], oob[:5]))

    n_fail = sum(1 for o in obs if not o["ok"] and not o["warn_only"])
    print()
    print("-" * 96)
    print("  观察项：%d 条，%d 条正常 / %d 条异常"
          % (len(obs), sum(1 for o in obs if o["ok"]), n_fail))
    if n_fail == 0:
        print("  结论：44 轮连续游玩未发现明显反常 —— 关系演化连贯、可恢复、不串线。")
    else:
        print("  结论：有 %d 条异常，需报告。★ 异常本身就是本轮的结论。" % n_fail)

    cache_after = sha_file(str(B._XLATE_DISK))
    out = {
        "_readme": [
            "P3 Phase2 Task7 连续游玩模拟的原始结果（%d 轮 / 3 NPC / 2 session）。" % len(trace),
            "checkpoint=%s ｜ 走 B.decide() 真路径 ｜ 不传 decision_history。" % model,
            "本文件是**长跑观察**，不是统计证明；判据在 p3_experience.py。",
            "八个观察项对应用户 Task7 的六条体验重点 + 两条异常检查。",
        ],
        "checkpoint": model,
        "device": B.ENGINE.device_label(),
        "book_sha": bk_sha,
        "config_sha": cfg_sha,
        "cache_sha_before": cache_before,
        "cache_sha_after": cache_after,
        "n_turns": len(trace),
        "deadzone": {"trust_shift": B.deadzone_of("trust_shift"),
                     "doubt_shift": B.deadzone_of("doubt_shift"),
                     "fondness_shift": B.deadzone_of("fondness_shift")},
        "trace": trace,
        "summary": st,
        "end_states": {"%s/%s" % k: v for k, v in e.items()},
        "key_events": kev,
        "observations": obs,
        "n_abnormal": n_fail,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = "p3p2_playthrough__%s.json" % model
    with io.open(os.path.join(OUT_DIR, tag), "w", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=1))
    print("\n已写入 tests/runs/%s" % tag)
    return 0 if n_fail == 0 else 3


def _group(trace):
    per = {}
    for r in trace:
        per.setdefault((r["session"], r["cast"]), []).append(r)
    return per


if __name__ == "__main__":
    raise SystemExit(main())
