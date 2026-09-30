"""P3-B 小批真实信号对照 · 可复跑 harness（桥内闭环：/analyze → /commit → /narrate）。

对照什么：
  - Laya 对玩家原话的判向（doubt_shift raw_delta）
  - 规则层裁决（evidence_handover / violence_escalation / pro_cooperation / —）
  - 应用后 doubt 变化与剧情档位
  - 云端叙事台词（节选）

纪律（沿用 tasks/P3-A-口径.md §5）：
  - 只产出配对数据，**不宣称质量通过**、不设断言、不下结论——由人读后确认；
  - 每组独立新鲜会话（sid 带时间戳），互不污染；
  - 期望列是本脚本作者标的「剧情节拍」参考，供复核，不作判定依据。

用法：
  PYTHONIOENCODING=utf-8 python tests/p3b_sig_compare.py [--out _diag/p3b_sig_results.json]
桥：默认 http://127.0.0.1:8131（可环境变量 LAYA_BRIDGE_BASE 覆盖）。
"""
import json
import time
import urllib.request
import urllib.error

BASE = __import__("os").environ.get("LAYA_BRIDGE_BASE", "http://127.0.0.1:8131")
AID = "lia"
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def call(path, body=None, post=True):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={"Content-Type": "application/json"} if data else {})
    try:
        with _OPENER.open(req, timeout=180) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.code, {}


# 6 组 × 2 轮；期望为剧情节拍（升/降/平），说明供复核
CASES = [
    {"name": "对峙施压", "note": "合理怀疑 → 拔刀升级（暴力保底）",
     "turns": [("升", "（直视她的眼睛）你到底瞒着我什么？"),
               ("升", "（拔刀抵在桌上）不说，就别想离开这间酒馆。")]},
    {"name": "证据让渡", "note": "坦白 + 出示名单（证据通道压制）",
     "turns": [("降", "好，我全告诉你——那晚的名单，在我怀里。"),
               ("降", "（掏出皱巴巴的名单）这就是你一直要找的东西。")]},
    {"name": "寒暄中立", "note": "闲聊不该动疑点（死区/微扰）",
     "turns": [("平", "今晚的酒不错，老板酿的？"),
               ("平", "（随口）听说镇口在加修栅栏，源头出了事吗？")]},
    {"name": "深夜诘问", "note": "证据式追问 → 疑点上升",
     "turns": [("升", "我见过你——前天半夜，你从东边哨站回来。"),
               ("升", "（压低声音）你认识守备队长，是吧？")]},
    {"name": "善意示好", "note": "搭手相助不升疑点",
     "turns": [("平", "（伸手帮她扶住差点倒下的货筐）小心。"),
               ("平", "路上若有麻烦，可以来找我。")]},
    {"name": "徽章试探", "note": "质问徽章来源=当面对质，非让渡（质问/指控豁免）",
     "turns": [("升", "你身上那枚徽章，哪来的？"),
               ("升", "（一步逼近）你跟灰军装到底是什么关系？")]},
]


def _doubt_of(s):
    return (s.get("current", {}).get("state") or {}).get("relationship", {}).get("doubt")


def run_group(gi, g):
    ts = time.strftime("%H%M%S") + str(time.time()).split(".")[1][:3]   # 亚秒盐：防止同秒重跑同桶污染
    sid = "p3bsig_%d_%s" % (gi + 1, ts)
    history, rows = [], []
    for rnd, (exp, line) in enumerate(g["turns"]):
        _, s = call("/state?session_id=%s&actor_id=%s" % (sid, AID))
        ver = s["current"]["state_version"]
        before = _doubt_of(s)
        ev = "p3b_%d_%d" % (gi + 1, rnd)
        _, ar = call("/analyze", {"session_id": sid, "actor_id": AID, "event_id": ev,
                                  "expected_state_version": ver, "message": line,
                                  "context": {"scene": "", "history": history[-8:]}})
        _, cr = call("/commit_state", {"session_id": sid, "actor_id": AID,
                                       "analysis_id": ar["analysis_id"],
                                       "expected_state_version": ver})
        _, nr = call("/narrate", {"mode": "analysis", "session_id": sid, "actor_id": AID,
                                  "analysis_id": ar["analysis_id"]})
        _, s2 = call("/state?session_id=%s&actor_id=%s" % (sid, AID))
        after = _doubt_of(s2)
        raw = ((ar.get("signals") or {}).get("doubt_shift") or {}).get("raw_delta")
        marker = next((d.get("rule_adjudicated") or "-" for d in
                       (cr.get("applied_delta") or cr.get("state_commits") or [])
                       if (d.get("target") or "").endswith("doubt")), "-")
        stage = ((nr or {}).get("plot_stage") or {}).get("key")
        row = {"round": rnd + 1, "exp": exp, "line": line,
               "raw": raw, "marker": marker,
               "doubt": [before, after], "stage": stage,
               "npc_line": (nr or {}).get("line") or ""}
        rows.append(row)
        history.append({"role": "user", "content": line})
        if row["npc_line"]:
            history.append({"role": "assistant", "content": row["npc_line"]})
    return rows


def main():
    argv = __import__("sys").argv
    out_path = None
    if "--out" in argv:
        out_path = argv[argv.index("--out") + 1]
    # --group <名>：只跑名字含该串的组（规则改动后低成本定向复跑，供复核闭环）
    group_filter = None
    if "--group" in argv:
        group_filter = argv[argv.index("--group") + 1]
    cases = [g for g in CASES
             if (not group_filter) or (group_filter in g["name"])]
    if not cases:
        print("没有匹配 --group=%s 的组；可选组名：%s"
              % (group_filter, "、".join(g["name"] for g in CASES)))
        return
    hdr = "%-6s %-2s %-3s %-22s %-16s %12s %-6s %s"
    print(hdr % ("组", "轮", "期望", "doubt_shift(raw)", "规则标记", "doubt 前→后",
                 "档位", "NPC 台词前44字"))
    print("-" * 150)
    groups = []
    for gi, g in enumerate(cases):
        rows = run_group(gi, g)
        groups.append({"name": g["name"], "note": g["note"], "turns": rows})
        for row in rows:
            d0, d1 = row["doubt"]
            arrow = "↑" if (d1 or 0) > (d0 or 0) + 0.05 else ("↓" if (d1 or 0) < (d0 or 0) - 0.05 else "→")
            print(hdr % (g["name"], row["round"], "%s%s" % (row["exp"], arrow),
                         ("%+.2f" % row["raw"]) if row["raw"] is not None else "—",
                         row["marker"],
                         "%s→%s" % ("—" if d0 is None else "%.0f" % d0,
                                    "—" if d1 is None else "%.0f" % d1),
                         row["stage"], row["npc_line"].replace("\n", " ")[:44]))
    results = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
               "base": BASE, "n_groups": len(CASES),
               "n_cloud_generations": sum(len(g["turns"]) for g in groups),
               "groups": groups}
    if out_path:
        __import__("pathlib").Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        __import__("pathlib").Path(out_path).write_text(
            json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
        print("\n结果已存 %s（云端生成 %d 次）" % (out_path, results["n_cloud_generations"]))
    else:
        print("\n云端生成 %d 次 —— 由人对照期望列复核，脚本不判定。"
              % results["n_cloud_generations"])


if __name__ == "__main__":
    main()