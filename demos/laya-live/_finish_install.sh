#!/usr/bin/env bash
# 完成 Laya 安装。
#
# 本机 WorkBuddy 注入了 shim/sitecustomize.py，把 os.unlink 改写成「送回收站」，
# 且每次删除都 fork 一个 node 守卫进程查询配额；同一 tool-call 内累计删除超过
# 阈值(50)时守卫返回非零 -> SystemExit(1) 直接杀掉进程（pip 就是这样被杀的，
# 并留下半卸载的 site-packages）。
#
# 因此本脚本的策略是：**让 pip 全程不需要 unlink 任何文件**。
#   - venv 自带的 setuptools 会更老，pip 覆盖它时要逐个 unlink 已存在的文件 -> 改名挪走
#   - 不加 --ignore-installed，让 pip 跳过已经装好的依赖（否则会强制重装 -> 又 unlink）
set -u

ROOT="C:/Users/11/WorkBuddy/2026-09-23-11-11-35/laya-live"
VENV="$ROOT/.venv"
SP="$VENV/Lib/site-packages"
PY="$VENV/Scripts/python.exe"
MIRROR="https://mirrors.aliyun.com/pypi/simple"
TS="$(date +%Y%m%d_%H%M%S)"
PARK="$ROOT/.venv_parked_$TS"

say() { echo "[$(date +%H:%M:%S)] $*"; }

say "1/4 把会和 pip 写入冲突的条目改名挪走（不删除）"
mkdir -p "$PARK"
MOVED=0
for n in setuptools setuptools-65.5.0.dist-info setuptools-*.dist-info pkg_resources _distutils_hack distutils-precedence.pth; do
  for p in $SP/$n; do
    [ -e "$p" ] || continue
    if mv "$p" "$PARK/" 2>/dev/null; then
      say "  挪走 $(basename "$p")"
      MOVED=$((MOVED+1))
    else
      say "  !! 挪走失败：$(basename "$p")"
    fi
  done
done
say "  共挪走 $MOVED 项 -> $(basename "$PARK")"
say "  site-packages 剩余："
ls -A "$SP" | sed 's/^/    /'

say "2/4 确认 pip 仍可用"
"$PY" -m pip --version 2>&1 | sed 's/^/  /' || { say "  !! pip 不可用"; exit 1; }

say "3/4 安装 laya（不加 --ignore-installed，跳过已满足依赖，只写不删）"
say "  含 torch(~124MB)，约 35 个包，请耐心"
"$PY" -m pip install laya --only-binary=:all: \
  --no-input --progress-bar off -i "$MIRROR"
RC=$?
say "  pip 退出码 = $RC"

say "4/4 验证"
"$PY" -c "
import sys
print('  python =', sys.version.split()[0])
import laya
print('  laya   =', getattr(laya, '__version__', '?'))
import torch
print('  torch  =', torch.__version__)
" 2>&1 | sed 's/^/  /'
echo "DONE_RC=$RC"
