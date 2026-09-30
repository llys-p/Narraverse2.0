"""P3-B 首次小对照：6 组场景 × 无信号/有信号，最多 12 次云端生成 + 1 次预热。

口径见 tasks/P3-A-口径.md §5。评价五条由人读原始配对后确认，本脚本只产出配对
（不宣称质量通过、不固定种子/数字阈值）。真实调用 DeepSeek（llm_narrate），
不加载 Laya 检查点、不触发翻译；结果 JSON 存 _diag/（不进 git）。

用法： PYTHONIOENCODING=utf-8 python tests/p3b_compare.py [--out _diag/p3b_results.json]
"""
import json
import os
import sys
import time
from pathlib import Path

# ★ 密钥权威与桥一致：编辑运行副本的 .env 覆盖系统环境的失效 key（尾号 d4f0）。
#   只注入到 os.environ，绝不打印 key / 尾号 / 请求头。
for _p in (Path(r"C:\Users\11\WorkBuddy\2026-09-23-11-11-35\laya-live\.env"),
           Path(__file__).resolve().parent.parent / ".env"):
    if _p.exists():
        for _line in _p.read_text(encoding="utf-8", errors="ignore").splitlines():
            _line = _line.strip()
            if not _line or _line.startswith("#"):
                continue
            for _k in ("DEEPSEEK_API_KEY", "LLM_API_KEY"):
                if _line.startswith(_k + "="):
                    _v = _line.split("=", 1)[1].strip().strip('"').strip("'")
                    os.environ[_k] = _v
        break

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import laya_bridge as B

ACTOR = dict(B.CFG.get("actor") or {})
ACTOR.setdefault("name", "莉亚")

GROUPS = [
    {"name": "正常闲聊", "scene": "旅店大厅",
     "input": "今晚的麦酒煮得不错。",
     "history": [{"role": "player", "text": "今晚的麦酒煮得不错。"}],
     "state_line": "relationship: trust=60 doubt=30 | emotion: fondness=0.35",
     "sig": "trust_shift: raw_delta=+0.6（参考）\ndoubt_shift: raw_delta=-0.5（参考）"},
    {"name": "示好", "scene": "旅店大厅",
     "input": "你一个人守着这家店也不容易，我帮你看看账本？",
     "history": [{"role": "player", "text": "你一个人守着这家店也不容易，我帮你看看账本？"}],
     "state_line": "relationship: trust=65 doubt=25 | emotion: fondness=0.45",
     "sig": "fondness_shift: raw_delta=+1.2（参考）\ntrust_shift: raw_delta=+1.5（参考）"},
    {"name": "质疑", "scene": "旅店后门",
     "input": "你说你是个旅人——那为什么腰上别着圣殿的短刀？",
     "history": [{"role": "player", "text": "你说你是个旅人——那为什么腰上别着圣殿的短刀？"}],
     "state_line": "relationship: trust=45 doubt=60 | emotion: fondness=0.2",
     "sig": "doubt_shift: raw_delta=+2.4（参考）\ncooperation: raw_delta=-1.2（参考）"},
    {"name": "威胁", "scene": "旅店后门",
     "input": "你要是不说，我就不客气了。",
     "history": [{"role": "player", "text": "你要是不说，我就不客气了。"}],
     "state_line": "relationship: trust=30 doubt=70 | emotion: fondness=0.1",
     "sig": "alert_shift: raw_delta=+3.0（参考）\ncooperation: raw_delta=-2.0（参考）"},
    {"name": "拒绝", "scene": "旅店柜台",
     "input": "我把整袋钱给你，灰鸦的事就当没听过。",
     "history": [{"role": "player", "text": "我把整袋钱给你，灰鸦的事就当没听过。"}],
     "state_line": "relationship: trust=50 doubt=40 | emotion: fondness=0.3",
     "sig": "respect_shift: raw_delta=-1.6（参考）\ndoubt_shift: raw_delta=+0.8（参考）"},
    {"name": "情节线索", "scene": "地窖入口",
     "input": "我在西边林子见过一个戴兜帽的人，和你想查的人很像。",
     "history": [{"role": "player", "text": "我在西边林子见过一个戴兜帽的人，和你想查的人很像。"}],
     "state_line": "relationship: trust=70 doubt=20 | emotion: fondness=0.5",
     "sig": "investigate: raw_delta=+1.9（参考）\ntrust_shift: raw_delta=+0.9（参考）"},
]


def call(input_text, state_line, signals_block, scene, history):
    return B.llm_narrate(ACTOR, None, input_text, history, state_line,
                         include_reasoning=False,
                         proactive=True, signals_block=signals_block, scene=scene)


def brief(r):
    if not r:
        return {"error": "llm_narrate 返回 None（无 key/网络/超限）"}
    if r.get("error"):
        return {"error": r["error"][:200]}
    return {"line": r.get("line"), "source": r.get("source"), "model": r.get("model"),
            "latency_ms": r.get("latency_ms"), "contaminated": r.get("contaminated")}


def main():
    out_path = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else None
    results = {"generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
               "count": 0, "groups": []}
    total = 0
    for i, g in enumerate(GROUPS):
        # 预热：第一批（正常闲聊·有信号）之前追加一次同组无信号
        if i == 0 and os.environ.get("P3B_NO_WARMUP") != "1":
            w = call(g["input"], g["state_line"], None, g["scene"], g["history"])
            total += 1
            print("[warmup] %s -> %s" % (g["name"], brief(w).get("line") or brief(w)))
        row = {"name": g["name"], "input": g["input"], "scene": g["scene"],
               "state_line": g["state_line"]}
        for tag, sig in (("no_signal", None), ("signal", g["sig"])):
            r = call(g["input"], g["state_line"], sig, g["scene"], g["history"])
            total += 1
            row[tag] = brief(r)
            print("\n==== [%s] %s ====" % (g["name"], tag))
            b = row[tag]
            if b.get("line"):
                print("line: %s" % b["line"][:240])
            else:
                print("err: %s" % b)
        results["groups"].append(row)
    results["count"] = total
    if out_path:
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        Path(out_path).write_text(json.dumps(results, ensure_ascii=False, indent=1),
                                  encoding="utf-8")
        print("\n结果已存 %s（本次云端生成 %d 次）" % (out_path, total))
    else:
        print("\n本次云端生成 %d 次" % total)


if __name__ == "__main__":
    main()