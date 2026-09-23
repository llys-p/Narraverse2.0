# -*- coding: utf-8 -*-
"""分阶段测模型加载耗时，回答「45s 到底花在哪」。

为什么需要它：`LayaEngine.init()` 的 load_ms 是一整块（import + 扫描 + Router + preload），
45s 这个数字没法归因。拆开之后才能判断 0.3.7 那条「跳过随机初始化」的优化
对我们有没有用 —— 如果时间花在磁盘读取或 tokenizer 上，跳过初始化就一点用没有。

用法：
  python -u tests/loadstage.py typed-decisions cpu
  python -u tests/loadstage.py english cuda
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
os.environ["LAYA_DEVICE"] = device

mdir = ROOT / "_models" / ("laya-" + name)
sizes = {}
for p in sorted(mdir.rglob("*")):
    if p.is_file():
        sizes[p.name] = p.stat().st_size
total_mb = sum(sizes.values()) / 1e6
big = sorted(sizes.items(), key=lambda kv: -kv[1])[:4]


def mark(label, t0):
    dt = time.perf_counter() - t0
    print("  %-34s %7.2f s" % (label, dt), flush=True)
    return dt


print("=" * 62)
print("检查点 %s   设备 %s" % (name, device))
print("目录 %s" % mdir)
print("总大小 %.1f MB，最大几个文件：" % total_mb)
for k, v in big:
    print("    %-30s %8.1f MB" % (k, v / 1e6))
print("-" * 62)

t0 = time.perf_counter()
import laya  # noqa: E402

t_import = mark("import laya", t0)
print("     laya 版本 %s" % getattr(laya, "__version__", "?"))

t0 = time.perf_counter()
r = laya.Router(models={name: str(mdir)}, preload=False, default=name, device=device)
t_router = mark("Router(preload=False)", t0)

t0 = time.perf_counter()
r.preload([name])
t_preload = mark("preload([%r])" % name, t0)

t0 = time.perf_counter()
try:
    out = r.predict({"message": "hello"}, [{"key": "k", "text": "Is this friendly?", "type": "noul"}])
    print("     首个输出 %r" % (str(out)[:120],))
except Exception as e:
    print("     首次 predict 失败（不重要，只看耗时）: %r" % (e,))
t_first = mark("首次 predict（含懒加载）", t0)

t_total = time.perf_counter() - t0 + t_import + t_router + t_preload
print("-" * 62)
print("  合计 %.2f s = import %.2f + Router %.2f + preload %.2f + predict %.2f"
      % (t_import + t_router + t_preload + t_first, t_import, t_router, t_preload, t_first))
print("  ★ 真正的「加载」是 import+Router+preload = %.2f s" % (t_import + t_router + t_preload))
print("=" * 62)
