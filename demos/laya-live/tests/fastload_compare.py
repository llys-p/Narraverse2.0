# -*- coding: utf-8 -*-
"""验证「跳过随机权重初始化」这条路在 0.3.5 上能不能走通，且答案是否位级一致。

背景：实测 preload 46.8 s，其中 build_model（= AutoModel.from_config，
对 4.2 亿参数做一次随机初始化）占 25.15 s，而读 842MB 权重只要 0.16 s。
上游 0.3.7 的 changelog 正是「不再做那次没用的随机初始化」「答案位级一致」。
但 0.3.7 不在 PyPI（最新 0.3.5），所以先在本机自己试一遍：

  做法：让 AutoModel.from_config 在 torch.device('meta') 下构建（只建形状，
        不分配也不填充），再 to_empty() 落成未初始化的真张量，
        随后 Agent 的 load_state_dict(strict=True) 会把所有权重覆盖成检查点里的值。

  ★ 风险：**不在 state_dict 里的 buffer**（典型是 RoPE 的 inv_freq 这类非持久 buffer）
    拿不到覆盖，会留着未初始化内存 → 输出可能是垃圾。所以必须做位级对比，
    不能只看「跑起来了」。

用法（两个进程必须分开跑）：
  python -u tests/fastload_compare.py off _diag/_fast_off.json
  python -u tests/fastload_compare.py on  _diag/_fast_on.json
  python -u tests/fastload_compare.py diag          # 只做「非持久 buffer 有哪些」的诊断
  python -u tests/fastload_compare.py cmp _diag/_fast_off.json _diag/_fast_on.json
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

mode = sys.argv[1] if len(sys.argv) > 1 else "normal"
out_path = sys.argv[2] if len(sys.argv) > 2 else None
os.environ["LAYA_DEVICE"] = "cpu"          # 对比用 CPU，避免 CUDA 的数值漂移混淆结论
os.environ["LAYA_MODEL"] = "typed-decisions"

mdir = ROOT / "_models" / "laya-typed-decisions"


# ---------------------------------------------------------------- 对比模式
if mode == "cmp":
    def flat(o, p=""):
        out = {}
        if isinstance(o, dict):
            for k, v in o.items():
                out.update(flat(v, p + "/" + str(k)))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                out.update(flat(v, p + "[%d]" % i))
        else:
            out[p] = o
        return out

    a = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    b = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
    fa, fb = flat(a), flat(b)
    print("展开后键数: A=%d  B=%d" % (len(fa), len(fb)))
    only = sorted(set(fa) ^ set(fb))
    print("只在一侧的键: %s" % (only[:8] or "无"))
    diff = [(k, fa[k], fb[k]) for k in sorted(set(fa) & set(fb)) if fa[k] != fb[k]]
    print("★ 不相等的值: %d / %d" % (len(diff), len(set(fa) & set(fb))))
    for k, x, y in diff[:10]:
        print("   %s  %r vs %r" % (k, x, y))
    sys.exit(0 if not diff and not only else 1)


# ---------------------------------------------------------------- 诊断模式
if mode == "diag":
    from safetensors.torch import load_file
    from laya.common import build_model

    cfg = json.loads((mdir / "rl_agent_config.json").read_text(encoding="utf-8"))
    weights = load_file(str(mdir / "model.safetensors"))
    t = time.perf_counter()
    m = build_model(cfg, str(mdir / "encoder"))
    print("build_model 正常构建: %.2f s" % (time.perf_counter() - t), flush=True)

    sd = m.state_dict()
    never_covered = [n for n, _ in m.named_buffers() if n not in sd]
    print("★ 不在 state_dict 里的 buffer（不会有任何东西覆盖它们）: %d 个" % len(never_covered))
    for n in never_covered[:15]:
        print("     %s" % n)
    print("检查点里没有的键（strict=True 会因此报错）: %s"
          % ([k for k in sd if k not in weights][:8] or "无"))
    print("检查点多余的键: %s" % ([k for k in weights if k not in sd][:8] or "无"))
    sys.exit(0)


# ---------------------------------------------------------------- 加载开关
# ★ 这里**不再由脚本自己打补丁**，改用产品代码里的开关 LAYA_FASTLOAD：
#   要验证的是已落地的那份实现，不是脚本里另写一份等价逻辑（那样会双双叠加、
#   测了个混合体，上一版脚本就踩了这个坑）。
if mode in ("off", "normal"):
    os.environ["LAYA_FASTLOAD"] = "0"
    print("[off] LAYA_FASTLOAD=0 —— 走 laya 原生构建（含被丢弃的随机初始化）", flush=True)
else:
    os.environ.setdefault("LAYA_FASTLOAD", "1")
    print("[on] LAYA_FASTLOAD=1 —— 走快加载", flush=True)


# ---------------------------------------------------------------- 正常 / 快加载
import laya_bridge as B  # noqa: E402

t = time.perf_counter()
B.ENGINE.init()
total = time.perf_counter() - t
print("ENGINE.init(): %.2f s（内部 load_ms=%d）" % (total, B.ENGINE.load_ms), flush=True)
print("  detail: %s" % B.ENGINE.detail, flush=True)
print("  ready : %s" % B.ENGINE.ready, flush=True)
if not B.ENGINE.ready:
    print("  ★ 加载失败，last_error=%s" % B.ENGINE.last_error, flush=True)
    sys.exit(2)

# 固定 10 组输入，覆盖「威胁 / 友好 / 辱骂 / 道歉 / 贿赂 / 提问 / 沉默 / 中性 / 道别 / 好感」
# 刻意都用英文直给，绕开翻译（DeepSeek 翻译有 0.055 量级的抖动，会污染位级对比）。
CASES = [
    "I hold a knife to your throat. Give me the gold.",
    "Thank you for saving my life, friend. Let me buy you a drink.",
    "You are a worthless coward and your mother was a whore.",
    "I am sorry for what I said yesterday. I was wrong.",
    "Ten silver coins, and you forget you ever saw me. Deal?",
    "Which road leads to the northern pass, and how long does it take?",
    "",
    "The harvest came in early this year. That is good news for the village.",
    "I will take my leave now. Take care of yourself, old friend.",
    "You have kind eyes. I have been watching you all evening.",
]
CASES = [{"player_input": c, "player_input_en": c} for c in CASES]

results = []
for i, case in enumerate(CASES):
    payload = dict(case)
    payload["actor"] = B.CFG["actor"]
    payload["history"] = []
    payload["seed"] = 7
    try:
        resp = B.decide(payload)
    except Exception as e:
        import traceback
        traceback.print_exc()
        results.append({"_error": repr(e)})
        continue
    # 只留可比对的数值/结构性字段，丢掉大段文本
    keep = {}
    for k in ("npc_behavior", "behavior", "decision", "decision_signals",
              "signals", "state_proposals", "proposed_deltas", "policy",
              "gates", "choice_baseline", "choice_argmax"):
        if k in resp:
            keep[k] = resp[k]
    results.append(keep)
    bh = (keep.get("decision") or {}).get("behavior") or {}
    print("  case%-2d → %-10s conf=%.4f  input=%r"
          % (i, bh.get("id"), bh.get("confidence") or 0.0, case["player_input"][:42]), flush=True)

if out_path:
    Path(out_path).write_text(json.dumps(results, ensure_ascii=False, indent=1, sort_keys=True,
                                         default=str), encoding="utf-8")
    print("已写出 %s" % out_path, flush=True)
