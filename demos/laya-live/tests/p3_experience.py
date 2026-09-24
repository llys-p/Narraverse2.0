"""Phase3-P3 第一版：最小体验测试（4 类场景，目标=发现重大体验 Bug）。

本阶段的目标**不是**统计证明，而是回答一个体验问题：
    「连续玩几轮，关系会不会自然变化；会不会突然跳变；多角色会不会串线。」

所以这里刻意**不**做大型矩阵。4 个场景，每个场景就是把一串玩家台词按顺序走一遍，
看每一轮的 trust 值。判据是体验口径的：

    [E1] 连续正向话语：trust **总体上升**，但**不能暴涨**
         （单轮变化必须 ≤ per_turn_max，且全程不能一步到位）
    [E2] 连续负向话语：trust **总体下降**
    [E3] 普通中性聊天：**不应**造成大幅关系漂移
         （累计 |Δ| 小于正向/负向场景的累计变化）
    [E4] 两个 NPC / 两个 session 交替：状态**不能串线**
         （A 桶的 trust 变化不得出现在 B 桶）

★ 为什么必须区分「总体上升」和「不暴涨」：
  只有前者，一个把所有输入都判成"极正"的模型也能满分；
  只有后者，一个永远不给变化的模型也能满分。两者是一对**互相牵制**的判据，
  缺任何一个都会让本测试失去意义。这是 P2.5 那次「6/6 全正」教训的直接产物。

★ decision_history 的已知问题（读向跨检查点不稳定）**不在本测试的判据里**。
  它是 P2.5 已记录的 limitation；本阶段不修，只观察它有没有造成**可见的体验异常**。
  相关观察单独放在 report 的 history_observation 字段里，不参与 PASS/FAIL。

用法：
    ./.venv/Scripts/python.exe tests/p3_experience.py
    LAYA_MODEL=english ./.venv/Scripts/python.exe tests/p3_experience.py
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

# 本地调用不该走代理（bridge 在 127.0.0.1；翻译走 HuggingFace 时才需要网络）
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

import laya_bridge as B  # noqa: E402

SCENARIOS = os.path.join(ROOT, "tests", "cases", "p3_experience.json")
OUT_DIR = os.path.join(ROOT, "tests", "runs")


def sha_file(p):
    if not os.path.exists(p):
        return None
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def walk(sc, session_id, actor_id, trace):
    """顺序走完一个场景，返回每轮记录。

    每一步都调 B.decide()（**不是**绕过状态层的 stage 函数）——
    体验测试必须走玩家真正走的那条路，否则测的是另一个系统。
    """
    rows = []
    for i, text in enumerate(sc["lines"]):
        out = B.decide({"player_input": text, "session_id": session_id,
                        "actor_id": actor_id})
        st = ((out.get("actor_state") or {}).get("state") or {})
        rel = st.get("relationship") or {}
        row = {
            "i": i + 1, "text": text,
            "label": (sc.get("labels") or [None] * len(sc["lines"]))[i],
            "trust_after": rel.get("trust"),
            "commits": [{"signal": c["signal"], "old": c["old"], "proposal": c["proposal"],
                         "final_delta": c["final_delta"], "new_value": c["new_value"],
                         "clamped_by": c["clamped_by"]}
                        for c in (out.get("state_commits") or [])],
            "n_skipped": len(out.get("state_skipped") or []),
            "behavior": ((out.get("decision") or {}).get("behavior") or {}).get("id"),
            "awaiting_upstream": (out.get("decision") or {}).get("awaiting_upstream"),
        }
        rows.append(row)
    trace.append({"id": sc["id"], "session": session_id, "actor": actor_id, "rows": rows})
    return rows


def deltas_of(rows):
    """每轮 trust 的单轮变化（第一轮相对场景起点，用 None 表示基准未知）。"""
    out = []
    prev = None
    for r in rows:
        t = r["trust_after"]
        out.append(None if (t is None or prev is None) else round(t - prev, 6))
        prev = t
    return out


def main():
    model = B.DEFAULT_MODEL_NAME
    blob = json.load(io.open(SCENARIOS, encoding="utf-8"))
    scs = {s["id"]: s for s in blob["scenarios"]}
    per_turn_max = ((B.CFG.get("state_shift") or {}).get("transition") or {}) \
        .get("per_turn_max", {}).get("trust_shift")

    ds_sha = sha_file(SCENARIOS)
    cfg_sha = B._config_fingerprint()["sha"]
    cache_before = sha_file(str(B._XLATE_DISK))

    print("=" * 94)
    print("P3 第一版最小体验测试 ｜ 检查点=%s ｜ 设备=%s ｜ 单轮上限=%s"
          % (model, B.ENGINE.device_label(), per_turn_max))
    print("场景集 %s ｜ sha=%s" % (os.path.basename(SCENARIOS), (ds_sha or "")[:16]))
    print("config sha=%s ｜ cache sha=%s" % (cfg_sha[:16], (cache_before or "")[:16]))
    print("=" * 94)

    B.ENGINE.init()
    if not B.ENGINE.ready:
        print("laya 未就绪，先跑 probe 看原因。")
        return 1

    # ---- 能力档案门禁：不 fresh 时状态层会**一条都不写**，本测试会全 0 -------
    # ★ 这个前置检查是必须的。没有它，基线失效会表现成「trust 全程不变」，
    #   看起来像「状态层坏了」或「模型不敏感」，实际只是门禁在按设计工作。
    #   P3 第一次跑就撞上过这个，所以这里把它变成显式前置条件而不是事后猜测。
    # ★ 变量名不能叫 chk —— 下面 208 行有同名局部函数 chk() 做判据，
    #   会把这份档案核对结果遮蔽掉，报 AttributeError: function has no attribute get。
    prof, prof_check = B.load_capability_profile(model)
    if not prof_check.get("fresh"):
        print("\n★ 前置条件未通过：能力档案不是 fresh，状态层将拒绝写任何 delta。")
        print("  这不是状态层的 bug —— 门禁就该这样。它对不上的是：")
        for p in prof_check.get("problems") or []:
            print("     · %s" % p)
        print("  先重建基线：")
        print("     ./.venv-cuda/Scripts/python.exe laya_bridge.py signalmetrics")
        print("     ./.venv-cuda/Scripts/python.exe laya_bridge.py capability")
        print("  （本脚本不复用旧档案、也不放宽门禁 —— 那等于把未验证的能力当已验证用）")
        return 2
    print("能力档案 fresh ✅ ｜ profile_id=%s" % (prof_check.get("profile_id") or "")[:16])
    writable = [s for s, v in ((prof.get("signals") or {})).items()
                if v.get("may_write_state")]
    print("本检查点可写 Actor State 的 signal：%s" % (", ".join(writable) or "（无）"))
    print("★ 本测试只判 trust_shift / relationship.trust 的闭环；"
          "其余可写 signal 即便在本轮 commit 了，也不进本测试的判据。")

    B.reset_actor_state()
    B.reset_history()

    trace = []
    print("\n" + "-" * 94)
    print("── 逐场景走查（每行是**一轮**玩家输入之后的状态）" + "-" * 40)

    # ---- E1 连续正向 ------------------------------------------------------
    sc1 = scs["e1_positive"]
    r1 = walk(sc1, "E1", "Lia", trace)
    print("\n[E1] 连续正向话语（%s）" % sc1["desc"])
    for r in r1:
        c = r["commits"]
        dv = ("%+g" % c[0]["final_delta"]) if c else "—"
        print("    %d. trust=%-6s Δ=%-7s %s" % (r["i"], r["trust_after"], dv, r["text"][:38]))

    # ---- E2 连续负向 ------------------------------------------------------
    sc2 = scs["e2_negative"]
    r2 = walk(sc2, "E2", "Lia", trace)
    print("\n[E2] 连续负向话语（%s）" % sc2["desc"])
    for r in r2:
        c = r["commits"]
        dv = ("%+g" % c[0]["final_delta"]) if c else "—"
        print("    %d. trust=%-6s Δ=%-7s %s" % (r["i"], r["trust_after"], dv, r["text"][:38]))

    # ---- E3 中性 ---------------------------------------------------------
    sc3 = scs["e3_neutral"]
    r3 = walk(sc3, "E3", "Lia", trace)
    print("\n[E3] 普通中性聊天（%s）" % sc3["desc"])
    for r in r3:
        c = r["commits"]
        dv = ("%+g" % c[0]["final_delta"]) if c else "—"
        print("    %d. trust=%-6s Δ=%-7s %s" % (r["i"], r["trust_after"], dv, r["text"][:38]))

    # ---- E4 两 NPC / 两 session 交替 -------------------------------------
    sc4 = scs["e4_positive_alt"]
    sc5 = scs["e5_negative_alt"]
    print("\n[E4] 两个 NPC × 两个 session 交替（A 正向 / B 负向，同一批输入混着走）")
    rA = walk(sc4, "S1", "Lia", trace)
    rB = walk(sc5, "S2", "Roth", trace)
    # 再回到 A 走一轮，验证 A 的状态没被 B 影响
    extra = dict(sc4)
    extra["id"] = "e4_positive_alt_reprise"
    extra["lines"] = [sc4["lines"][0]]
    extra["labels"] = ["回到 A"]
    rA2 = walk(extra, "S1", "Lia", trace)
    print("    A(S1/Lia)  正向 %d 轮 → trust=%s" % (len(rA), rA[-1]["trust_after"]))
    print("    B(S2/Roth) 负向 %d 轮 → trust=%s" % (len(rB), rB[-1]["trust_after"]))
    print("    A 回到同一桶再来一轮      → trust=%s" % rA2[-1]["trust_after"])

    # ================= 判据 ================================================
    print("\n" + "=" * 94)
    print("── 判据（体验口径）" + "-" * 60)

    checks = []

    def chk(cid, name, ok, detail, warn=False):
        checks.append({"id": cid, "name": name, "ok": bool(ok),
                       "detail": detail, "warn_only": warn})

    t1 = [r["trust_after"] for r in r1]
    d1 = [d for d in deltas_of(r1) if d is not None]
    span1 = (max(t1) - min(t1)) if len(t1) > 1 else 0
    chk("E1a", "连续正向 → trust 总体上升",
        t1 and t1[-1] is not None and t1[-1] > t1[0],
        "起点 %s → 终点 %s（净变化 %+.1f）"
        % (t1[0] if t1 else None, t1[-1] if t1 else None,
           (t1[-1] - t1[0]) if (t1 and t1[-1] is not None) else 0))

    # 不暴涨：任一轮的单轮变化不得超过 per_turn_max（这是配置承诺的硬上限）
    if d1 and per_turn_max is not None:
        worst = max(d1, key=abs)
        chk("E1b", "连续正向 → 没有暴涨（单轮变化 ≤ 配置上限）",
            abs(worst) <= per_turn_max + 1e-6,
            "最大单轮 Δ=%+g，配置上限=%s" % (worst, per_turn_max))
    else:
        chk("E1b", "连续正向 → 没有暴涨", False,
            "没有任何一轮发生 commit（Δ 全为空）—— 无法证明「上升被限制」，"
            "因为根本没有上升")

    # 还要求**不是一步到位**：经历过至少 2 次正 commit
    n_pos = sum(1 for d in d1 if d > 0)
    chk("E1c", "连续正向 → 变化是逐轮累积的（不是一轮到位）",
        n_pos >= 2,
        "%d 轮产生了正向变化（共 %d 轮有效）" % (n_pos, len(d1)))

    t2 = [r["trust_after"] for r in r2]
    d2 = [d for d in deltas_of(r2) if d is not None]
    chk("E2", "连续负向 → trust 总体下降",
        t2 and t2[-1] is not None and t2[-1] < t2[0],
        "起点 %s → 终点 %s（净变化 %+.1f）"
        % (t2[0] if t2 else None, t2[-1] if t2 else None,
           (t2[-1] - t2[0]) if (t2 and t2[-1] is not None) else 0))

    t3 = [r["trust_after"] for r in r3]
    d3 = [abs(d) for d in deltas_of(r3) if d is not None]
    drift3 = sum(d3)
    drift1 = sum(abs(d) for d in d1)
    drift2 = sum(abs(d) for d in d2)
    # 中性场景的累计漂移应当**明显小于**有明显倾向的场景。
    # 用 min(正向, 负向) 作参照：只要比两者中较小的那个小，就算通过 ——
    # 门槛刻意宽松，本阶段只抓「中性聊天把关系推走一大截」这种明显异常。
    ref = min(drift1, drift2) if (drift1 and drift2) else None
    e3_ok = (drift3 <= ref) if ref else True
    # ★ E3 未过时要能指出「是哪一轮、多少分」，否则「中性漂移大」是一句无法行动的话。
    #   实测 english 上正是「外面雨好像停了」一轮 Δ=-5.76 把累计拉到 8.3 ——
    #   单看总数看不出是"普遍偏负"还是"某一轮爆掉"，这两者的处理方式完全不同。
    worst_row, worst_dv = None, 0.0
    for r in r3:
        ts = [c for c in (r["commits"] or []) if c["signal"] == "trust_shift"]
        dv = ts[0]["final_delta"] if ts else 0.0
        if abs(dv) > abs(worst_dv):
            worst_row, worst_dv = r, dv
    # 方向一致性：中性场景里有多少轮是"负向"的。
    # 若多数轮都是负的，说明这是**系统性偏负**（模型把中性话读成轻微损害信任），
    # 而不是偶发抖动 —— 两者的严重程度不一样，必须分开报告。
    n_neg = sum(1 for d in (deltas_of(r3) or []) if d is not None and d < 0)
    n_val = len([d for d in (deltas_of(r3) or []) if d is not None])
    chk("E3", "中性聊天 → 不造成大幅关系漂移",
        e3_ok,
        "中性累计 |Δ|=%.1f ｜ 正向=%.1f 负向=%.1f（参照取两者较小值 %s）"
        " ｜ 最大单轮 Δ=%+.2f（「%s」）｜ %d/%d 轮为负向%s"
        % (drift3, drift1, drift2, ("%.1f" % ref) if ref else "—",
           worst_dv, (worst_row or {}).get("text", "?")[:14], n_neg, n_val,
           "（→ 系统性偏负，不是偶发抖动）" if n_neg >= (n_val * 0.6) else ""))
    findings = {
        "e3": {
            "cumulative_abs_delta": round(drift3, 4),
            "ref_min_positive_negative": round(ref, 4) if ref else None,
            "worst_turn": {"text": (worst_row or {}).get("text"),
                           "delta": round(worst_dv, 4)},
            "n_negative_turns": n_neg, "n_turns": n_val,
            "systematic_negative_bias": bool(n_neg >= (n_val * 0.6)),
        },
    }

    a_end, b_end = rA[-1]["trust_after"], rB[-1]["trust_after"]
    chk("E4a", "两个 session 的状态互不影响",
        (a_end is not None and b_end is not None and a_end > b_end),
        "A(正向 session)=%s ｜ B(负向 session)=%s —— 同起点、相反方向，"
        "若串线两者会趋于相同" % (a_end, b_end))

    # 回到 A 桶再走一轮：应当从 A 自己的值继续，而不是从 B 的值
    chk("E4b", "回到同一桶时状态被保留（不是每次重来）",
        (rA2[-1]["trust_after"] is not None and a_end is not None
         and abs(rA2[-1]["trust_after"] - a_end) <= (per_turn_max or 12) + 1e-6
         and rA2[-1]["trust_after"] != (B.CFG["actor"]["relationship"]["trust"])),
        "A 再来一轮后 trust=%s（上一轮结束于 %s，模板初值 %s）"
        % (rA2[-1]["trust_after"], a_end, B.CFG["actor"]["relationship"]["trust"]))

    # 桶隔离的直接证据：读两个桶的当前状态
    vA = B.actor_state_view("S1", "Lia")
    vB = B.actor_state_view("S2", "Roth")
    iso = (vA["bucket"] != vB["bucket"])
    chk("E4c", "Actor State 按 (session, actor) 分桶",
        iso and vA["exists"] and vB["exists"],
        "桶 %s 与 %s 各自存在，trust 分别 %s / %s"
        % (vA["bucket"], vB["bucket"],
           ((vA["state"] or {}).get("relationship") or {}).get("trust"),
           ((vB["state"] or {}).get("relationship") or {}).get("trust")))

    # ---- 观察项：decision_history 的已知限制有没有造成可见异常 -------------
    # ★ 不参与 PASS/FAIL。P2.5 已记录「history 读向跨检查点不稳定」，本阶段不修。
    hist_obs = {
        "known_limitation": ("decision_history 的读向跨检查点不稳定（P2.5 §18.4/§18.5）。"
                             "P3 第一阶段不修，仅观察是否造成可见体验异常。"),
        "observed": "本测试的 5 个场景都未传 decision_history（历史桶为空），"
                    "因此**没有**观察到 history 造成的异常 —— 这是「未触及」，不是「已验证无害」。",
        "verdict": "未构成 P3 阻塞项；继续按已知限制记录。",
    }

    # ---- 汇总 ------------------------------------------------------------
    n_pass = sum(1 for c in checks if c["ok"])
    n_fail = len(checks) - n_pass
    print()
    for c in checks:
        print("  %s [%s] %s" % ("✅" if c["ok"] else "❌", c["id"], c["name"]))
        print("        %s" % c["detail"])

    print("\n" + "-" * 94)
    print("  合计 %d 项：%d PASS / %d FAIL" % (len(checks), n_pass, n_fail))
    if n_fail == 0:
        print("  结论：4 类体验场景均通过 —— trust_shift 的第一版闭环在体验层成立。")
    else:
        print("  结论：有 %d 项未通过。★ 未通过项本身就是本轮的结论，不要调参凑过去。" % n_fail)

    cache_after = sha_file(str(B._XLATE_DISK))
    out = {
        "_readme": [
            "P3 第一版最小体验测试的原始结果（4 类场景 / 共 6 次顺序走查）。",
            "checkpoint=%s ｜ 走的是 B.decide() 真路径，不绕过状态层。" % model,
            "判据是体验口径：总体方向 + 不暴涨 + 中性不漂移 + 不串线。",
            "decision_history 的已知限制**不在判据里**，单独放 history_observation。",
        ],
        "checkpoint": model,
        "device": B.ENGINE.device_label(),
        "scenarios_sha": ds_sha,
        "config_sha": cfg_sha,
        "cache_sha_before": cache_before,
        "cache_sha_after": cache_after,
        "per_turn_max_trust": per_turn_max,
        "capability_profile_id": prof_check.get("profile_id"),
        "state_writable_signals": writable,
        "trace": trace,
        "checks": checks,
        "n_pass": n_pass, "n_fail": n_fail,
        "history_observation": hist_obs,
        "findings": findings,
        "corner": {
            "e1_span": span1, "e1_deltas": d1,
            "e2_deltas": d2, "e3_abs_deltas": d3,
            "drift_positive": drift1, "drift_negative": drift2, "drift_neutral": drift3,
            "e4": {"a_end": a_end, "b_end": b_end, "a_reprise": rA2[-1]["trust_after"]},
        },
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    tag = "p3_experience__%s.json" % model
    with io.open(os.path.join(OUT_DIR, tag), "w", encoding="utf-8") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=1))
    print("\n已写入 tests/runs/%s" % tag)
    return 0 if n_fail == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main())
