# -*- coding: utf-8 -*-
"""把 Agent.__init__ 内部的每一步单独计时。

动机：`preload` 要 46 s，但纯磁盘读 842MB 只要 0.43 s → 时间不在 IO。
上游 0.3.7 的说明是「不再做一次没用的随机权重初始化」，而 agent.py:188 的
`build_model()` 恰好就是「先建随机权重、再被 load_state_dict 覆盖」——
本脚本就是去证实/证伪这一点：如果 build_model 占掉大头，那 0.3.7 对我们是**真收益**。

用法：python -u tests/loadstage_detail.py [typed-decisions] [cpu]
"""
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

name = sys.argv[1] if len(sys.argv) > 1 else "typed-decisions"
device = sys.argv[2] if len(sys.argv) > 2 else "cpu"
mdir = str(ROOT / "_models" / ("laya-" + name))

t0 = time.perf_counter()
import laya.agent as A  # noqa: E402

print("import: %.2f s" % (time.perf_counter() - t0), flush=True)

steps = []


def wrap(mod, attr, label):
    orig = getattr(mod, attr, None)
    if orig is None:
        print("  （%s 不存在，跳过）" % attr, flush=True)
        return

    def timed(*a, **k):
        t = time.perf_counter()
        r = orig(*a, **k)
        dt = time.perf_counter() - t
        steps.append((label, dt))
        print("  %-38s %7.2f s" % (label, dt), flush=True)
        return r

    setattr(mod, attr, timed)


# ★ agent.py 里 `load_file` / `AutoTokenizer` 都是**函数内 import**，
#   所以必须去改源模块，改 laya.agent 的属性没用（我第一次就踩了这个）。
import safetensors.torch as _st  # noqa: E402
import transformers as _tf  # noqa: E402

wrap(A, "build_model", "build_model（随机权重构建）")
wrap(_st, "load_file", "safetensors.load_file（读 842MB）")
wrap(_tf.AutoTokenizer, "from_pretrained", "AutoTokenizer.from_pretrained")

# state_dict 装载：给 model 类打补丁不好做，改用 torch 层面看
import torch.nn as nn  # noqa: E402

_orig_lsd = nn.Module.load_state_dict


def timed_lsd(self, *a, **k):
    t = time.perf_counter()
    r = _orig_lsd(self, *a, **k)
    dt = time.perf_counter() - t
    steps.append(("model.load_state_dict", dt))
    print("  %-38s %7.2f s" % ("model.load_state_dict", dt), flush=True)
    return r


nn.Module.load_state_dict = timed_lsd

print("-" * 62, flush=True)
t0 = time.perf_counter()
agent = A.Agent(mdir, device=device)
total = time.perf_counter() - t0
print("-" * 62)
print("Agent(...) 总计 %.2f s" % total)
for k, v in steps:
    print("   %-38s %7.2f s  (%.0f%%)" % (k, v, 100 * v / total))
print("   未归因（.to(device)/eval/config 解析等）  %7.2f s"
      % (total - sum(v for _, v in steps)))
print("=" * 62)
