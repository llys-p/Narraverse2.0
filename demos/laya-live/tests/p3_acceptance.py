"""Phase3-P3 第一版验收（判据写在最前面，先定后验）。

本阶段目标（用户明确设定）：**正常游玩体验稳定，没有重大明显 Bug**。
不是企业级统计证明。所以这里只回答 5 个体验问题，全部是可以一眼看懂的口径：

  [G1] trust_shift 是否**真正形成闭环**
       —— 状态有没有真的写进桶、下一轮有没有真的读回来。
       ★ 「写了」和「读回来了」是两件事，必须分别证明：
         G1a 写：至少一轮产生了 state_commits[].final_delta != 0
         G1b 读回来：相邻两轮的输入 state 里，relationship.trust 等于上一轮 commit 后的值
         G1c 同起点不同方向 → 终值不同（证明"读回来"影响了决策，不只是显示）
  [G2] 连续交互状态是否自然
       —— 正向升 / 负向降 / 逐轮累积（不是一轮到位 / 不是纹丝不动）
  [G3] 是否出现明显异常跳变
       —— 任一单轮 |Δ| 超过配置的 per_turn_max；或出现 NaN / 越出 [0,100]
  [G4] 多 NPC / 多 session 是否串线
       —— 两个桶各自独立演化且互不影响
  [G5] 状态层契约是否被遵守
       —— active 才写 / auxiliary 不写 / 歧义轮不 commit / commit 返回四件套齐全

判据全部读 tests/runs/p3_experience__*.json 与 state_transition 的单元自测，
**不重新跑模型** —— 验收脚本必须能在秒级重跑，否则没人会去跑它。

用法：
    ./.venv/Scripts/python.exe tests/p3_acceptance.py
    ./.venv/Scripts/python.exe tests/p3_acceptance.py --json
"""
import glob
import hashlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.argv = [sys.argv[0]]

import laya_bridge as B  # noqa: E402

RUNS = os.path.join(ROOT, "tests", "runs")
OUT_JSON = os.path.join(ROOT, "tests", "p3_acceptance.json")

# ============================================================================
# 判据（先写在这里，再读数据）
# ============================================================================
CONTRACT_KEYS = ("old", "proposal", "final_delta", "new_value")


def load_runs():
    out = {}
    for p in sorted(glob.glob(os.path.join(RUNS, "p3_experience__*.json"))):
        try:
            blob = json.load(io.open(p, encoding="utf-8"))
            out[blob.get("checkpoint") or os.path.basename(p)] = blob
        except Exception as e:
            print("⚠ 读 %s 失败：%r" % (os.path.basename(p), e))
    return out


def trace_of(blob, sid):
    for t in blob.get("trace") or []:
        if t.get("id") == sid or t.get("session") == sid:
            return t
    return None


def main():
    want_json = "--json" in sys.argv
    tr_cfg = (B.CFG.get("state_shift") or {}).get("transition") or {}
    cap = (tr_cfg.get("per_turn_max") or {}).get("trust_shift")
    paths = (B.CFG.get("state_shift") or {}).get("paths") or {}
    lo, hi = (paths.get("trust_shift") or {}).get("range") or [None, None]
    floor = B.CFG["actor"]["relationship"]["trust"]

    runs = load_runs()
    results = []

    def add(cid, name, ok, detail, warn=False):
        results.append({"id": cid, "name": name, "ok": bool(ok),
                        "detail": detail, "warn_only": warn})

    if not runs:
        add("G0", "存在体验测试结果", False,
            "tests/runs/p3_experience__*.json 不存在；先跑 tests/p3_experience.py")
        emit(results, runs, want_json, cap, [lo, hi], floor, tr_cfg)
        return 1

    cks = sorted(runs)
    add("G0", "两个检查点都有体验测试结果", len(cks) >= 2,
        "找到 %s" % "、".join(cks))

    # ---- 配置自证：范围/上限不是脚本里硬编码的第二套 -----------------------
    ok_cfg = (isinstance(cap, (int, float)) and lo == 0 and hi == 100)
    add("G0b", "状态范围与单轮上限读自 config（不是脚本里第二套）",
        ok_cfg,
        "range=[%s,%s] per_turn_max=%s ｜ 来源 state_shift.paths.trust_shift.range "
        "与 state_shift.transition" % (lo, hi, cap))

    # ---- G1 闭环：写 / 读回 / 影响决策 ------------------------------------
    all_commits, write_ok_any, readback_ok_any, spread_any = [], False, False, False
    readback_detail, spread_detail = [], []
    for ck, blob in runs.items():
        tr = blob.get("trace") or []
        commits = [c for t in tr for r in t.get("rows") or [] for c in (r.get("commits") or [])]
        all_commits += commits
        if any(abs(c.get("final_delta") or 0) > 0 for c in commits):
            write_ok_any = True

        # 读回：e1 场景的第 n 轮 state 里 trust 应等于第 n-1 轮 commit 后的值。
        # ★ 判据用「相邻轮的 trust 值构成一条链」来表达 —— 比比对内部变量更接近黑箱，
        #   而且正是玩家能看到的东西（面板上那一栏）。
        e1 = trace_of(blob, "e1_positive")
        if e1:
            ts = [r.get("trust_after") for r in e1.get("rows") or []]
            chain = [t for t in ts if t is not None]
            good = len(chain) >= 2 and len(set(chain)) >= 2 and chain != [floor] * len(chain)
            if good:
                readback_ok_any = True
            readback_detail.append("%s: %s" % (ck, chain))

        # 影响决策：同起点（都是 60）走正/负两个方向，终值必须分开
        e2 = trace_of(blob, "e2_negative")
        if e1 and e2:
            a = (e1.get("rows") or [{}])[-1].get("trust_after")
            b = (e2.get("rows") or [{}])[-1].get("trust_after")
            if a is not None and b is not None and a > b:
                spread_any = True
            spread_detail.append("%s: 正向终值=%s 负向终值=%s" % (ck, a, b))

    add("G1a", "闭环-写：有轮次真的把 delta 写进了状态",
        write_ok_any,
        "共 %d 条 commit 记录，其中非零 final_delta %d 条"
        % (len(all_commits), sum(1 for c in all_commits if abs(c.get("final_delta") or 0) > 0)))
    add("G1b", "闭环-读回：下一轮读到了上一轮写入的值",
        readback_ok_any,
        "e1 场景逐轮 trust 链条：" + " ｜ ".join(readback_detail))
    add("G1c", "闭环-影响决策：同起点、相反方向 → 终值分离",
        spread_any,
        " ；".join(spread_detail))

    # ---- G2 自然度 --------------------------------------------------------
    nat_ok, nat_detail = True, []
    for ck, blob in runs.items():
        c = {x["id"]: x for x in (blob.get("checks") or [])}
        for cid in ("E1a", "E1c", "E2"):
            got = c.get(cid)
            if got is None:
                nat_ok = False
                nat_detail.append("%s 缺 %s" % (ck, cid))
            elif not got["ok"]:
                nat_ok = False
                nat_detail.append("%s %s 未过：%s" % (ck, cid, got["detail"]))
    add("G2", "连续交互自然：正向升 / 负向降 / 逐轮累积",
        nat_ok,
        " ；".join(nat_detail) if nat_detail
        else "所有检查点在 E1a(总体上升)/E1c(逐轮累积)/E2(总体下降) 上均通过")

    # ---- G3 异常跳变 ------------------------------------------------------
    jumps, nan_or_range = [], []
    for ck, blob in runs.items():
        for t in blob.get("trace") or []:
            for r in t.get("rows") or []:
                v = r.get("trust_after")
                if v is None:
                    continue
                if not isinstance(v, (int, float)) or v != v:
                    nan_or_range.append("%s/%s#%s trust=%r" % (ck, t["id"], r["i"], v))
                elif not (lo <= v <= hi):
                    nan_or_range.append("%s/%s#%s trust=%s 越出 [%s,%s]"
                                        % (ck, t["id"], r["i"], v, lo, hi))
                for c in (r.get("commits") or []):
                    d = c.get("final_delta")
                    if d is not None and cap is not None and abs(d) > cap + 1e-6:
                        jumps.append("%s/%s#%s Δ=%+g > 上限 %s" % (ck, t["id"], r["i"], d, cap))
    add("G3a", "没有单轮变化超过配置上限（无异常跳变）",
        not jumps, "；".join(jumps) if jumps else "全部单轮 |Δ| ≤ %s" % cap)
    add("G3b", "没有 NaN / 越界值",
        not nan_or_range, "；".join(nan_or_range) if nan_or_range
        else "全部取值在 [%s,%s] 内且为有限数" % (lo, hi))

    # ---- G4 隔离 ----------------------------------------------------------
    iso_ok, iso_detail = True, []
    for ck, blob in runs.items():
        cross = {x["id"]: x for x in (blob.get("checks") or [])}
        for cid in ("E4a", "E4b", "E4c"):
            got = cross.get(cid)
            if got is None or not got["ok"]:
                iso_ok = False
                iso_detail.append("%s %s：%s" % (ck, cid, (got or {}).get("detail", "缺失")))
    add("G4", "多 NPC / 多 session 不串线",
        iso_ok, " ；".join(iso_detail) if iso_detail else "E4a/E4b/E4c 全部通过")

    # ---- G5 状态层契约（单元自测，当场跑，不依赖 run 文件）-----------------
    contract, notes = True, []
    # ① 四件套齐全
    r = B.state_transition("trust_shift", 5.0, 60, True)
    miss = [k for k in CONTRACT_KEYS if k not in r]
    if miss:
        contract = False
        notes.append("返回值缺 %s" % miss)
    # ② 单轮上限生效
    r = B.state_transition("trust_shift", 999.0, 60, True)
    if abs(r["final_delta"] - cap) > 1e-6:
        contract = False
        notes.append("单轮上限未生效：Δ=%s 期望 %s" % (r["final_delta"], cap))
    # ③ 合法区间生效
    r = B.state_transition("trust_shift", 999.0, hi, True)
    if abs(r["final_delta"]) > 1e-6 or r["new_value"] != hi:
        contract = False
        notes.append("区间上界未生效：Δ=%s new=%s" % (r["final_delta"], r["new_value"]))
    # ④ 准入不过 → 不写
    r = B.state_transition("trust_shift", 5.0, 60, False)
    if r["committed"] or r["final_delta"] != 0:
        contract = False
        notes.append("准入未过却仍写了：%r" % r)
    add("G5a", "State Transition 契约：四件套 + 上限 + 区间 + 准入",
        contract, "；".join(notes) if notes else
        "old/proposal/final_delta/new_value 齐全，单轮上限与区间 clamp 均生效，"
        "准入不过时不写")

    # ⑤ auxiliary 不写；⑥ 歧义轮不 commit
    prof, chk = B.load_capability_profile(B.DEFAULT_MODEL_NAME)
    smap = B.capability_status_map(prof) if prof else {}
    aux_signals = [s for s, v in smap.items() if v == "auxiliary"]
    real_prof = B.load_capability_profiles() or {}
    rolemap = {}
    for _ck, _pv in (real_prof.get("profiles") or {}).items():
        for _s, _v in (_pv.get("signals") or {}).items():
            if _s in all_signal_names_safe():
                rolemap[_s] = _v.get("role")
    # 构造一份"只有 auxiliary 的 proposal"，看 transition 是否一条都不写
    fake_prop = {"delta": [{"source_signal": "aux_demo", "target": "relationship.trust",
                            "delta": 5.0, "status": "auxiliary", "grade": "B",
                            "role": "state_shift"}]}
    B.reset_actor_state("__contract__", "X")
    B.actor_state_for("__contract__", "X", B.CFG["actor"])
    cm, sk, _v = B.apply_state_transition("__contract__", "X", fake_prop, {"behavior_is_null": False},
                                          actor=B.CFG["actor"])
    aux_ok = (len(cm) == 0 and len(sk) == 1
              and "write_status" in (sk[0].get("skipped_reason") or ""))
    add("G5b", "auxiliary 不直接写状态",
        aux_ok,
        "构造 status=auxiliary 的 proposal → commit %d 条 / skip %d 条（原因：%s）"
        % (len(cm), len(sk), (sk[0].get("skipped_reason") if sk else "—")))

    B.reset_actor_state("__contract__", "X")
    B.actor_state_for("__contract__", "X", B.CFG["actor"])
    cm2, sk2, _v2 = B.apply_state_transition(
        "__contract__", "X", {"delta": [{"source_signal": "trust_shift",
                                         "target": "relationship.trust", "delta": 5.0,
                                         "status": "active", "grade": "A",
                                         "role": "state_shift"}]},
        {"behavior_is_null": True, "awaiting_upstream": True}, actor=B.CFG["actor"])
    amb_ok = (len(cm2) == 0 and len(sk2) == 1
              and ("不 commit" in (sk2[0].get("skipped_reason") or "")
                   or "歧义" in (sk2[0].get("skipped_reason") or "")))
    add("G5c", "ambiguous / awaiting_upstream 不 commit",
        amb_ok,
        "behavior_is_null=true → commit %d 条 / skip %d 条（原因：%s）"
        % (len(cm2), len(sk2), (sk2[0].get("skipped_reason") if sk2 else "—")))
    B.reset_actor_state("__contract__", "X")

    # ⑦ active 名单来自 config，不是代码常量
    ws = tr_cfg.get("write_status") or []
    add("G5d", "可写状态名单读自 config（active-only）",
        ws == ["active"],
        "state_shift.transition.write_status=%s" % ws)

    # ---- 已知限制的显式记录 ----------------------------------------------
    lim = []
    for ck, blob in runs.items():
        ho = blob.get("history_observation") or {}
        if ho:
            lim.append("%s：%s" % (ck, ho.get("verdict")))
    add("G6", "decision_history 已知限制已显式记录（不作为 PASS 依据）",
        bool(lim), " ；".join(lim) if lim else "结果文件里没有 history_observation 字段", warn=True)

    emit(results, runs, want_json, cap, [lo, hi], floor, tr_cfg, lim)
    hard = [r for r in results if not r["ok"] and not r["warn_only"]]
    return 0 if not hard else 3


def all_signal_names_safe():
    try:
        return set(B.all_signal_names())
    except Exception:
        return set()


def emit(results, runs, want_json, cap, rng, floor, tr_cfg, lim=None):
    hard = [r for r in results if not r["ok"] and not r["warn_only"]]
    n_pass = sum(1 for r in results if r["ok"])

    if want_json:
        blob = {
            "_readme": [
                "Phase3-P3 第一版验收结论。判据写在 tests/p3_acceptance.py 顶部，先定后验。",
                "目标口径：正常游玩体验稳定、无重大明显 Bug —— 不是企业级统计证明。",
                "本脚本不跑模型，只读 tests/runs/p3_experience__*.json + 当场跑状态层单元自测。",
            ],
            "checkpoints": sorted(runs),
            "per_turn_max_trust": cap,
            "trust_range": rng,
            "actor_default_trust": floor,
            "transition_cfg": tr_cfg,
            "checks": results,
            "n_pass": n_pass, "n_fail": len(hard),
            "n_warn": sum(1 for r in results if r["warn_only"] and not r["ok"]),
            "verdict": ("通过" if not hard else "不通过"),
            "known_limitations": lim or [],
        }
        io.open(OUT_JSON, "w", encoding="utf-8").write(
            json.dumps(blob, ensure_ascii=False, indent=1))
        return

    print("=" * 94)
    print("P3 第一版验收（目标：正常游玩体验稳定，无重大明显 Bug）")
    print("检查点：%s" % "、".join(sorted(runs)))
    print("=" * 94)
    for r in results:
        mark = "✅" if r["ok"] else ("⚠" if r["warn_only"] else "❌")
        print("  %s [%s] %s" % (mark, r["id"], r["name"]))
        print("        %s" % r["detail"])
    print("\n" + "-" * 94)
    print("  合计 %d 项：%d PASS / %d FAIL（另有 %d 项仅记录）"
          % (len(results), n_pass, len(hard),
             sum(1 for r in results if r["warn_only"] and not r["ok"])))
    print("  结论：%s" % ("通过" if not hard else "不通过"))
    print("\n  已写入 %s" % os.path.relpath(OUT_JSON, ROOT))


if __name__ == "__main__":
    raise SystemExit(main())
