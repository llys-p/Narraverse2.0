"""Phase3-P3：最小体验测试（4 类场景，目标=发现重大体验 Bug）。

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

── Phase2 追加（关系维度扩展，见报告 §20）--------------------------------
    [N1] 中性闲聊 ×10：关系不应明显漂移（比 E3 的 5 轮更长，专门压漂移）
    [D1] doubt 能持续 commit（闭环）
    [F1] fondness 能持续 commit（闭环）
    [X1] 关系维度**互不硬绑定**：trust 上涨时 doubt / fondness 不被自动带动
    [X2] 「trust 高 + fondness 低」这种组合能真实出现（不是虚构的）

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

SCENARIOS = os.path.join(ROOT, "tests", "experience", "p3_experience.json")
OUT_DIR = os.path.join(ROOT, "tests", "runs")


def sha_file(p):
    if not os.path.exists(p):
        return None
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def walk(sc, session_id, actor_id, trace):
    """顺序走完一个场景，返回每轮记录。

    每一步都先调纯分析 B.decide()，再显式调 B.commit_state()——
    与新版 Analyze → Commit 职责分层一致，不再依赖 decide 的隐式副作用。

    ★ Phase2：除了 relationship.trust，也把 doubt / fondness / respect 一起记下来。
      只记 trust 的话，「维度之间有没有被硬绑定」这种问题在数据里根本看不出来。
    """
    rows = []
    for i, text in enumerate(sc["lines"]):
        out = B.decide({"player_input": text, "session_id": session_id,
                        "actor_id": actor_id})
        turn = out.get("turn") or {}
        if turn.get("turn_id"):
            commits, skipped, state_view = B.commit_state(
                turn.get("session_id"), turn.get("actor_id"), out.get("state_proposal") or {},
                (out.get("state_validation") or {}).get("decision") or {},
                actor=B.CFG.get("actor"))
            out = dict(out, state_commits=commits, state_skipped=skipped)
            if state_view.get("exists"):
                out["actor_state"] = {"source": "committed", **state_view}
        st = ((out.get("actor_state") or {}).get("state") or {})
        rel = st.get("relationship") or {}
        emo = st.get("emotion") or {}
        row = {
            "i": i + 1, "text": text,
            "label": (sc.get("labels") or [None] * len(sc["lines"]))[i],
            "trust_after": rel.get("trust"),
            "doubt_after": rel.get("doubt"),
            "respect_after": rel.get("respect"),
            "fondness_after": emo.get("fondness"),
            "commits": [{"signal": c["signal"], "old": c["old"], "proposal": c["proposal"],
                         "after_deadzone": c.get("after_deadzone"),
                         "final_delta": c["final_delta"], "new_value": c["new_value"],
                         "clamped_by": c["clamped_by"],
                         "deadzone_applied": (c.get("deadzone") or {}).get("applied")}
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


def dim_deltas(rows, key):
    """任意维度的逐轮变化（用于 doubt / fondness 的闭环与独立性判断）。"""
    out = []
    prev = None
    for r in rows:
        v = r.get(key)
        out.append(None if (v is None or prev is None) else round(v - prev, 6))
        prev = v
    return out


def sig_commits(rows, signal):
    """取每轮该 signal 的 commit（没有就 None），便于看闭环是否真的在跑。"""
    out = []
    for r in rows:
        hit = [c for c in (r.get("commits") or []) if c["signal"] == signal]
        out.append(hit[0] if hit else None)
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

    # ================= Phase2：关系维度扩展判据 ============================
    # ★ N1：10 轮闲聊。比 E3 更严的地方在于「轮数翻倍」——
    #   单轮 -1 的漂移在 5 轮里不明显，在 10 轮里就是 -10，正是玩家抱怨的那种。
    scN = scs["n1_neutral_long"]
    rN = walk(scN, "N1", "Lia", trace)
    print("\n[N1] 连续 10 轮闲聊（专门压中性漂移）")
    for r in rN:
        ts = [c for c in (r["commits"] or []) if c["signal"] == "trust_shift"]
        dv = ("%+g" % ts[0]["final_delta"]) if ts else "—"
        dz = "·死区" if (ts and ts[0].get("deadzone_applied")) else ""
        print("    %2d. trust=%-7s Δ=%-7s%s %s" % (r["i"], r["trust_after"], dv, dz, r["text"][:32]))

    tN = [r["trust_after"] for r in rN if r["trust_after"] is not None]
    driftN = abs(tN[-1] - tN[0]) if len(tN) > 1 else 0.0
    n_dz = sum(1 for r in rN for c in (r["commits"] or [])
               if c["signal"] == "trust_shift" and c.get("deadzone_applied"))
    # 参照：同一检查点上，5 轮正向/负向的累计漂移按轮数折算到 10 轮。
    # ★ 用「折算后的参照」而不是绝对值，是为了让判据与轮数无关 ——
    #   否则 10 轮的场景天然比 5 轮的漂移大，判据会变成一个轮数的函数。
    scaled = (min(drift1, drift2) / 5.0 * 10.0) if (drift1 and drift2) else None
    chk("N1", "10 轮闲聊 → 关系不明显漂移",
        (driftN <= scaled) if scaled else True,
        "10 轮累计 |Δ|=%.1f ｜ 参照（5 轮场景折算到 10 轮）=%.1f ｜ "
        "死区拦下 %d/%d 轮 ｜ 起 %s → 终 %s"
        % (driftN, scaled if scaled else -1, n_dz, len(rN),
           tN[0] if tN else None, tN[-1] if tN else None))

    # ---- D：doubt 闭环 + 方向 -------------------------------------------
    scD1, scD2 = scs["d1_doubt_rise"], scs["d2_doubt_fall"]
    rD1 = walk(scD1, "D1", "Lia", trace)
    rD2 = walk(scD2, "D2", "Lia", trace)
    print("\n[D] doubt 方向（应升 / 应降）")
    for tag, rr in (("应升", rD1), ("应降", rD2)):
        print("    %s：" % tag + " ".join(
            "%s" % (r["doubt_after"]) for r in rr))

    cD1 = sig_commits(rD1, "doubt_shift")
    cD2 = sig_commits(rD2, "doubt_shift")
    nD1 = sum(1 for c in cD1 if c)
    nD2 = sum(1 for c in cD2 if c)
    chk("D1", "doubt 能连续 commit（闭环成立）",
        nD1 >= 2 and nD2 >= 2,
        "应升场景 %d/%d 轮有 doubt commit ｜ 应降场景 %d/%d 轮"
        % (nD1, len(rD1), nD2, len(rD2)))
    dD1 = [d for d in dim_deltas(rD1, "doubt_after") if d is not None]
    dD2 = [d for d in dim_deltas(rD2, "doubt_after") if d is not None]
    chk("D2", "doubt 方向与语义一致（威胁/矛盾→升，合作/坦白→降）",
        (sum(dD1) > 0) and (sum(dD2) < 0),
        "应升组净 %+.2f ｜ 应降组净 %+.2f" % (sum(dD1), sum(dD2)))

    # ---- F：fondness 闭环 + 方向 ----------------------------------------
    scF1, scF2 = scs["f1_fondness_rise"], scs["f2_fondness_fall"]
    rF1 = walk(scF1, "F1", "Lia", trace)
    rF2 = walk(scF2, "F2", "Lia", trace)
    print("\n[F] fondness 方向（应升 / 应降）")
    for tag, rr in (("应升", rF1), ("应降", rF2)):
        print("    %s：" % tag + " ".join("%s" % (r["fondness_after"]) for r in rr))

    cF1 = sig_commits(rF1, "fondness_shift")
    cF2 = sig_commits(rF2, "fondness_shift")
    nF1 = sum(1 for c in cF1 if c)
    nF2 = sum(1 for c in cF2 if c)
    chk("F1", "fondness 能连续 commit（闭环成立）",
        nF1 >= 2 and nF2 >= 2,
        "应升场景 %d/%d 轮有 fondness commit ｜ 应降场景 %d/%d 轮"
        % (nF1, len(rF1), nF2, len(rF2)))
    dF1 = [d for d in dim_deltas(rF1, "fondness_after") if d is not None]
    dF2 = [d for d in dim_deltas(rF2, "fondness_after") if d is not None]
    chk("F2", "fondness 方向与语义一致（关心/尊重→升，羞辱/冷漠→降）",
        (sum(dF1) > 0) and (sum(dF2) < 0),
        "应升组净 %+.4f ｜ 应降组净 %+.4f" % (sum(dF1), sum(dF2)))

    # ---- X：维度之间不硬绑定 --------------------------------------------
    # ★ 这是 Task5 的核心。判法：在**每个**场景里看 trust 与 doubt/fondness 的变化方向，
    #   统计「trust 涨而 doubt 也涨」这种同向次数。若维度被硬绑定，应该几乎不存在反向组合；
    #   实测存在同向与反向混合 → 各维度是各自 signal 决定的。
    pair = []
    for t in trace:
        if t["id"] in ("e4_positive_alt_reprise",):
            continue
        rs = t["rows"]
        dt = [d for d in dim_deltas(rs, "trust_after") if d is not None]
        dd = [d for d in dim_deltas(rs, "doubt_after") if d is not None]
        df = [d for d in dim_deltas(rs, "fondness_after") if d is not None]
        for i in range(min(len(dt), len(dd), len(df))):
            pair.append((dt[i], dd[i], df[i]))
    same_td = sum(1 for a, b, _ in pair if a * b > 0)     # trust 与 doubt 同向
    opp_td = sum(1 for a, b, _ in pair if a * b < 0)      # 反向
    same_tf = sum(1 for a, _, c in pair if a * c > 0)
    opp_tf = sum(1 for a, _, c in pair if a * c < 0)
    chk("X1", "关系维度不硬绑定（存在 trust 与 doubt/fondness 反向变化的轮次）",
        opp_td > 0 and opp_tf > 0,
        "trust↔doubt：同向 %d 轮 / 反向 %d 轮 ｜ trust↔fondness：同向 %d 轮 / 反向 %d 轮 "
        "（若硬绑定，反向应为 0）" % (same_td, opp_td, same_tf, opp_tf))

    # 「trust 高 + fondness 低」这种复杂组合能否真实存在
    # 取所有桶里 trust 最高的一桶，看它的 fondness 是否被自动拉到高
    best = None
    for (sid, aid) in (("E1", "Lia"), ("S1", "Lia"), ("F2", "Lia"), ("D1", "Lia"), ("N1", "Lia")):
        v = B.actor_state_view(sid, aid)
        stt = (v.get("state") or {})
        t_ = ((stt.get("relationship") or {}).get("trust"))
        f_ = ((stt.get("emotion") or {}).get("fondness"))
        if t_ is not None and f_ is not None and (best is None or t_ > best[0]):
            best = (t_, f_, "%s/%s" % (sid, aid))
    # 找一个 trust 高但 fondness 不高的组合：只要存在 trust 明显高于初值而
    # fondness 不高于初值的桶，就说明两者没有被绑成同向。
    tpl_t = B.CFG["actor"]["relationship"]["trust"]
    tpl_f = B.CFG["actor"]["emotion"]["fondness"]
    combos = []
    for (sid, aid) in (("E1", "Lia"), ("S1", "Lia"), ("F2", "Lia"), ("D1", "Lia"),
                       ("N1", "Lia"), ("D2", "Lia"), ("F1", "Lia")):
        v = B.actor_state_view(sid, aid)
        stt = (v.get("state") or {})
        t_ = ((stt.get("relationship") or {}).get("trust"))
        f_ = ((stt.get("emotion") or {}).get("fondness"))
        if t_ is not None and f_ is not None:
            combos.append((sid, t_, f_))
    hi_t_low_f = [c for c in combos if c[1] > tpl_t and c[2] <= tpl_f]
    chk("X2", "「trust 高 + fondness 低」组合能真实出现",
        len(hi_t_low_f) > 0,
        "模板初值 trust=%s fondness=%s ｜ 满足「trust 高于初值且 fondness 不高于初值」的桶：%s"
        % (tpl_t, tpl_f,
           "、".join("%s(trust=%.1f,fond=%.3f)" % c for c in hi_t_low_f) or "（无）"))

    # ---- Task4 观察项：respect_shift 只接观察链路，不写状态 ----------------
    # ★ 这一项不是「额外功能」，而是**证明它确实没写进去**。
    #   respect_shift 在 typed-decisions 上是 auxiliary（grade C），
    #   按 Task4 要求可以进 Proposal / 展示 / 日志，但不得 Commit。
    #   如果不显式测，它「悄悄写进去了」和「正确地没写」在输出上是一样的。
    respect_obs = {"status": None, "wrote_any": False, "proposal_seen": False,
                   "verdict": "", "candidate_for_promotion": None}
    vR = B.actor_state_view("N1", "Lia")
    respect_obs["status"] = "auxiliary（见能力档案）"
    rchk = prof_check.get("signals") or {}
    # 从档案里取 respect_shift 的 status 与 grade（有就说真话，没有就说明没取到）
    rp = None
    try:
        pr = B.load_capability_profile(model)[0] or {}
        rp = (pr.get("signals") or {}).get("respect_shift") or {}
    except Exception:
        rp = None
    if rp:
        respect_obs["status"] = rp.get("status")
        respect_obs["grade"] = rp.get("grade")
        respect_obs["auc"] = rp.get("auc")
        respect_obs["may_write_state"] = rp.get("may_write_state")
    # 实测：整轮走查里 respect_after 有没有变过
    respect_vals = []
    for t in trace:
        for r in t["rows"]:
            if r.get("respect_after") is not None:
                respect_vals.append(r["respect_after"])
    tpl_r = B.CFG["actor"]["relationship"]["respect"]
    respect_obs["wrote_any"] = any(abs(v - tpl_r) > 1e-9 for v in respect_vals)
    respect_obs["observed_values"] = sorted(set(respect_vals))
    respect_obs["template_value"] = tpl_r
    # proposal 里有没有 respect_shift（能观测 = 接上了观察链路）
    respect_obs["proposal_seen"] = any(
        "respect_shift" in json.dumps((r.get("commits") or []) + [], ensure_ascii=False)
        for r in (rN + r1)) or False
    # 直接查一次：respect_shift 是否出现在 state_proposal 的 delta 里
    try:
        _pr = B.load_capability_profile(model)[0] or {}
        _sig = (_pr.get("signals") or {}).get("respect_shift") or {}
        respect_obs["proposal_seen"] = bool(_sig.get("role") == "state_shift")
    except Exception:
        pass
    if not respect_obs["wrote_any"]:
        respect_obs["verdict"] = ("✅ 全程未写入 Actor State（respect 恒为 %s），"
                                  "符合 auxiliary 不直接写的要求。" % tpl_r)
    else:
        respect_obs["verdict"] = "❌ 竟然写入了 Actor State —— auxiliary 不应直接写。"
    respect_obs["candidate_for_promotion"] = (
        "本轮未发现反常，但**样本量不足以判断升级价值**；"
        "按 Task4 只记录 candidate_for_promotion，不改 Capability Grade。")
    chk("R1", "respect_shift（auxiliary）确实没有写入 Actor State",
        not respect_obs["wrote_any"],
        "respect 观测值=%s ｜ 模板初值=%s ｜ %s"
        % (respect_obs["observed_values"], tpl_r, respect_obs["verdict"]))

    # ---- 观察项：decision_history 的已知限制有没有造成可见异常 -------------
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
        print("  结论：体验场景均通过 —— 关系闭环在体验层成立。")
    else:
        print("  结论：有 %d 项未通过。★ 未通过项本身就是本轮的结论，不要调参凑过去。" % n_fail)

    cache_after = sha_file(str(B._XLATE_DISK))
    out = {
        "_readme": [
            "P3 最小体验测试的原始结果（体验场景 + 顺序走查）。",
            "checkpoint=%s ｜ 走 B.decide() 纯分析 + B.commit_state() 显式提交。" % model,
            "判据是体验口径：总体方向 + 不暴涨 + 中性不漂移 + 不串线 + 维度不硬绑定。",
            "decision_history 的已知限制**不在判据里**，单独放 history_observation。",
            "Phase2 追加：N1（10 轮闲聊）/ D（doubt 方向）/ F（fondness 方向）/",
            "  X1（维度不硬绑定）/ X2（trust高+fondness低 组合存在）/ R1（respect 不写状态）。",
        ],
        "checkpoint": model,
        "device": B.ENGINE.device_label(),
        "scenarios_sha": ds_sha,
        "config_sha": cfg_sha,
        "cache_sha_before": cache_before,
        "cache_sha_after": cache_after,
        "per_turn_max_trust": per_turn_max,
        "deadzone": {"trust_shift": B.deadzone_of("trust_shift"),
                     "doubt_shift": B.deadzone_of("doubt_shift"),
                     "fondness_shift": B.deadzone_of("fondness_shift")},
        "capability_profile_id": prof_check.get("profile_id"),
        "state_writable_signals": writable,
        "trace": trace,
        "checks": checks,
        "n_pass": n_pass, "n_fail": n_fail,
        "history_observation": hist_obs,
        "respect_observation": respect_obs,
        "findings": findings,
        "corner": {
            "e1_span": span1, "e1_deltas": d1,
            "e2_deltas": d2, "e3_abs_deltas": d3,
            "drift_positive": drift1, "drift_negative": drift2, "drift_neutral": drift3,
            "drift_neutral_10": driftN, "neutral_deadzone_hits": n_dz,
            "doubt": {"rise_net": sum(dD1), "fall_net": sum(dD2)},
            "fondness": {"rise_net": sum(dF1), "fall_net": sum(dF2)},
            "independence": {"trust_doubt_same": same_td, "trust_doubt_opp": opp_td,
                             "trust_fond_same": same_tf, "trust_fond_opp": opp_tf},
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
