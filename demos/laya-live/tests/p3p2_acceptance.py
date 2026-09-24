"""Phase3-P3 Phase2 验收（秒级，不跑模型）。

判据写在**顶部**，先定后验。只读测试产物 + 当场跑状态层单元自测，
所以能在秒级重跑 —— 否则没人会去跑它。

── 判据（用户 Task14 的验收标准）------------------------------------------
必须满足：
  G1  trust / doubt / fondness 都能连续 Commit
  G2  正向长期总体上升
  G3  负向长期总体下降
  G4  中性聊天不会明显漂移关系
  G5  单轮没有明显暴涨暴跌
  G6  不超 state range
  G7  多 NPC 不串状态
  G8  多 session 不串状态
  G9  ambiguous 不 Commit
  G10 Capability Profile 仍然控制写权限
  G11 respect_shift（auxiliary）没有写入 Actor State
  G12 关系维度之间不硬绑定
  G13 连续游玩 44 轮无异常（Task7）

可接受的小问题（**不计 FAIL**，只在输出里提示）：
  · 个别一句话判断奇怪
  · 某个状态偶尔变化幅度偏大/偏小
  · English checkpoint 体验较差
  · auxiliary signal 暂时没用
  · decision_history 影响不理想
  · 少量边界 case 不完美

用法：
    ./.venv/Scripts/python.exe tests/p3p2_acceptance.py
    ./.venv/Scripts/python.exe tests/p3p2_acceptance.py --json
"""
import io
import json
import os
import subprocess
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
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")

import laya_bridge as B  # noqa: E402

RUNS = os.path.join(ROOT, "tests", "runs")
WANT_JSON = "--json" in sys.argv

CHECKS = []
NOTES = []


def chk(cid, name, ok, detail):
    CHECKS.append({"id": cid, "name": name, "ok": bool(ok), "detail": detail})


def note(tag, detail):
    NOTES.append({"id": tag, "detail": detail})


def load(fn):
    p = os.path.join(RUNS, fn)
    if not os.path.exists(p):
        return None
    return json.load(io.open(p, encoding="utf-8"))


def main():
    print("=" * 96)
    print("Phase3-P3 Phase2 验收（关系维度扩展 + 中性死区；目标=无明显重大 Bug）")
    print("=" * 96)

    exp_td = load("p3_experience__typed-decisions.json")
    exp_en = load("p3_experience__english.json")
    play_td = load("p3p2_playthrough__typed-decisions.json")
    play_en = load("p3p2_playthrough__english.json")

    have = [n for n, v in (("typed-decisions", exp_td), ("english", exp_en)) if v]
    chk("G0", "两个检查点都有体验测试结果", bool(have),
        "找到 %s" % "、".join(have) if have else "一个都没有 —— 先跑 tests/p3_experience.py")

    # ---- G10 能力档案仍然控制写权限 ---------------------------------------
    prof_ok = []
    for m in ("typed-decisions", "english"):
        try:
            pr, pc = B.load_capability_profile(m)
            writable = sorted(s for s, v in ((pr or {}).get("signals") or {}).items()
                              if v.get("may_write_state"))
            prof_ok.append((m, pc.get("fresh"), writable))
        except Exception as ex:
            prof_ok.append((m, False, ["ERR:%s" % ex]))
    chk("G10", "能力档案仍然控制写权限（fresh 且可写集合由档案决定）",
        all(f for _, f, _ in prof_ok),
        " ｜ ".join("%s: fresh=%s 可写=%s" % (m, f, ",".join(w) or "无") for m, f, w in prof_ok))
    for m, f, w in prof_ok:
        if m == "typed-decisions" and f:
            chk("G1", "trust / doubt / fondness 三个 signal 都在可写集合里",
                set(w) >= {"trust_shift", "doubt_shift", "fondness_shift"},
                "可写=%s" % ",".join(w))
        if m == "typed-decisions" and f:
            chk("G11a", "respect_shift 不在可写集合里（auxiliary 不直接写）",
                "respect_shift" not in w, "可写=%s" % ",".join(w))
            # aux 级别的 signal 都不得可写
            pr = B.load_capability_profile(m)[0] or {}
            bad = [s for s, v in (pr.get("signals") or {}).items()
                   if v.get("may_write_state") and v.get("status") != "active"]
            chk("G10b", "只有 status=active 的 signal 可写", not bad,
                "越权的：%s" % (bad or "无"))

    # ---- 从体验测试结果推导 G1–G8 ----------------------------------------
    if exp_td:
        ck = {c["id"]: c for c in exp_td.get("checks") or []}
        corner = exp_td.get("corner") or {}

        # G1 闭环：三个 signal 各自都有 commit
        n_com = {}
        for t in exp_td.get("trace") or []:
            for r in t.get("rows") or []:
                for c in r.get("commits") or []:
                    n_com[c["signal"]] = n_com.get(c["signal"], 0) + 1
        chk("G1", "trust / doubt / fondness 都能连续 Commit",
            all(n_com.get(s, 0) >= 5 for s in ("trust_shift", "doubt_shift", "fondness_shift")),
            "commit 次数：%s" % "、".join("%s=%d" % (k, v) for k, v in sorted(n_com.items())))

        chk("G2", "正向长期总体上升", ck.get("E1a", {}).get("ok") and ck.get("E1c", {}).get("ok"),
            (ck.get("E1a") or {}).get("detail", "缺 E1a"))
        chk("G3", "负向长期总体下降", ck.get("E2", {}).get("ok"),
            (ck.get("E2") or {}).get("detail", "缺 E2"))
        chk("G7", "多 NPC 不串状态", ck.get("E4a", {}).get("ok") and ck.get("E4c", {}).get("ok"),
            (ck.get("E4a") or {}).get("detail", "缺 E4a"))
        chk("G8", "多 session 不串状态", ck.get("E4b", {}).get("ok"),
            (ck.get("E4b") or {}).get("detail", "缺 E4b"))
        chk("G12", "关系维度不硬绑定", ck.get("X1", {}).get("ok") and ck.get("X2", {}).get("ok"),
            "%s ｜ %s" % ((ck.get("X1") or {}).get("detail", ""), (ck.get("X2") or {}).get("detail", "")))

        # G4 中性漂移：5 轮与 10 轮的判据都要过
        e3 = ck.get("E3", {})
        n1 = ck.get("N1", {})
        chk("G4", "中性聊天不会明显漂移关系（5 轮 + 10 轮两档）",
            e3.get("ok") and n1.get("ok"),
            "E3(5轮)：%s ｜ N1(10轮)：%s" % (e3.get("detail", "?"), n1.get("detail", "?")))
        if not e3.get("ok"):
            note("G4/E3 未过", "★ 未通过项本身就是本轮的结论，不要调参凑过去。详见报告 §20.2。")
        if not n1.get("ok"):
            note("G4/N1 未过", "10 轮闲聊漂移超过折算参照 —— 这是「长期相处被慢慢磨掉」的直接证据。")

        # G5 单轮不暴涨
        maxd = 0.0
        for t in exp_td.get("trace") or []:
            for r in t.get("rows") or []:
                for c in r.get("commits") or []:
                    if c["signal"] in ("trust_shift", "doubt_shift"):
                        maxd = max(maxd, abs(c["final_delta"]))
        limits = ((B.CFG.get("state_shift") or {}).get("transition") or {}).get("per_turn_max") or {}
        lim = max(v for k, v in limits.items() if k != "default")
        chk("G5", "单轮没有明显暴涨暴跌", maxd <= lim + 1e-6,
            "体验测试里最大单轮 |Δ|=%.3f ｜ 配置上限=%s" % (maxd, lim))

        # G6 不越界（直接看落盘后的最终值）
        vals = []
        for t in exp_td.get("trace") or []:
            for r in t.get("rows") or []:
                vals.append((r.get("trust_after"), r.get("doubt_after"), r.get("fondness_after")))
        bad = [v for v in vals if v[0] is not None and not (0 <= v[0] <= 100)] + \
              [v for v in vals if v[1] is not None and not (0 <= v[1] <= 100)] + \
              [v for v in vals if v[2] is not None and not (0 <= v[2] <= 1)]
        chk("G6", "不超 state range", not bad,
            "trust∈[0,100] doubt∈[0,100] fondness∈[0,1]，越界 %d 处" % len(bad))

        # G11 respect 没写入
        chk("G11", "respect_shift（auxiliary）没有写入 Actor State",
            (ck.get("R1") or {}).get("ok", False),
            (ck.get("R1") or {}).get("detail", "缺 R1"))

    # ---- G9 ambiguous 不 Commit（当场跑单元） -----------------------------
    B.reset_actor_state()
    prop = {"delta": [{"source_signal": "trust_shift", "target": "relationship.trust",
                       "delta": 9.0, "status": "active", "grade": "A", "role": "state_shift"}]}
    c, s, _ = B.apply_state_transition("ACC", "Lia", prop,
                                       {"behavior_is_null": True, "awaiting_upstream": True,
                                        "turn_id": "t1"})
    trust_after = B.actor_state_for("ACC", "Lia")["relationship"]["trust"]
    chk("G9", "ambiguous / awaiting_upstream 不 Commit",
        len(c) == 0 and trust_after == B.CFG["actor"]["relationship"]["trust"],
        "commit=%d ｜ trust 保持 %s" % (len(c), trust_after))

    # ---- G9b 死区真的在生效 ----------------------------------------------
    r0 = B.state_transition("trust_shift", B.deadzone_of("trust_shift") * 0.5, 60)
    r1 = B.state_transition("trust_shift", B.deadzone_of("trust_shift") * 3, 60)
    chk("G9b", "中性死区在生效（小变化归零 / 大变化保留）",
        r0["final_delta"] == 0.0 and abs(r1["final_delta"]) > 0,
        "阈值=%s ｜ 半阈值→Δ=%s ｜ 三倍阈值→Δ=%s"
        % (B.deadzone_of("trust_shift"), r0["final_delta"], r1["final_delta"]))

    # ---- G13 连续游玩 ----------------------------------------------------
    if play_td:
        chk("G13", "连续游玩 44 轮无异常（Task7）",
            (play_td.get("n_abnormal") or 0) == 0,
            "%d 轮 ｜ 异常 %s 条 ｜ 观察：%s"
            % (play_td.get("n_turns"), play_td.get("n_abnormal"),
               "、".join("%s%s" % (o["id"], "✅" if o["ok"] else "❌")
                         for o in (play_td.get("observations") or []))))
    else:
        chk("G13", "连续游玩结果存在", False,
            "缺 tests/runs/p3p2_playthrough__typed-decisions.json —— 先跑 tests/p3p2_playthrough.py")

    # ---- 单元自测（状态层契约） ------------------------------------------
    try:
        p = subprocess.run([sys.executable, os.path.join(HERE, "p3p2_unit.py")],
                           capture_output=True, text=True, timeout=120)
        ok = (p.returncode == 0)
        tail = (p.stdout or "").strip().splitlines()
        summ = [l for l in tail if "合计" in l]
        chk("G14", "状态层单元自测全过（死区/顺序/字段/range/准入/不硬绑定）",
            ok, summ[-1].strip() if summ else (p.stdout or "")[-160:])
    except Exception as ex:
        chk("G14", "状态层单元自测", False, "跑不起来：%s" % ex)

    # ---- 可接受的小问题（不计 FAIL） -------------------------------------
    if exp_en:
        ck_en = {c["id"]: c for c in exp_en.get("checks") or []}
        if not (ck_en.get("E3") or {}).get("ok"):
            note("English E3", "english 中性漂移仍超标 —— 用户已明确「English 不作为当前体验优化"
                               "的阻塞项」，故不计 FAIL，但如实记录。")
    note("decision_history", "本轮 5+10 个场景**都没有传** decision_history → "
                             "结论是「未触及」，不是「已验证无害」。")
    note("respect_shift", "只接观察链路，applied=false；本轮不改 Capability Grade，"
                          "仅记 candidate_for_promotion。")

    # ---- 汇总 -------------------------------------------------------------
    n_pass = sum(1 for c in CHECKS if c["ok"])
    n_fail = len(CHECKS) - n_pass
    print()
    for c in CHECKS:
        print("  %s [%s] %s" % ("✅" if c["ok"] else "❌", c["id"], c["name"]))
        print("        %s" % c["detail"])
    if NOTES:
        print()
        print("  ── 可接受的小问题 / 说明（不计 FAIL）──")
        for n in NOTES:
            print("    · [%s] %s" % (n["id"], n["detail"]))
    print()
    print("-" * 96)
    print("  合计 %d 项：%d PASS / %d FAIL（另有 %d 条备注）"
          % (len(CHECKS), n_pass, n_fail, len(NOTES)))
    print("  结论：%s" % ("通过" if n_fail == 0 else "有 %d 项未通过" % n_fail))
    if n_fail:
        print("  ★ 未通过项本身就是本轮的结论，不要调参凑过去。")

    if WANT_JSON:
        out = {"checks": CHECKS, "notes": NOTES, "n_pass": n_pass, "n_fail": n_fail,
               "verdict": "通过" if n_fail == 0 else "未通过"}
        with io.open(os.path.join(ROOT, "tests", "p3p2_acceptance.json"), "w",
                     encoding="utf-8") as f:
            f.write(json.dumps(out, ensure_ascii=False, indent=1))
        print("\n  已写入 tests/p3p2_acceptance.json")
    return 0 if n_fail == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main())
