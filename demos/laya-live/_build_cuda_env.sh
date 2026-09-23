#!/usr/bin/env bash
# 建立独立的 CUDA 测试环境（不动现有 .venv）。
#
# ★ 两条硬约束（都踩过）：
#   1. **绝对不要 `pip install --upgrade pip setuptools`** —— 升级要先卸载旧版，
#      而卸载走 shutil.rmtree，会被沙箱的删除守卫「搬到回收站」而不是真删，
#      pip 随即找不到目录 → OSError，最后 pip 和 setuptools 双双消失。
#      要装什么直接装，一切「先卸载再装」的操作在这个环境里都不安全。
#   2. 先装 cu126 的 torch，再装 transformers / laya；反过来的话 laya 会把
#      CPU 版 torch 拉进来，且因为 2.14.0+cu126 > 2.14.0 而不会被自动纠正。
set -x
ROOT="C:/Users/11/WorkBuddy/2026-09-23-11-11-35/laya-live"
cd "$ROOT" || exit 1
mkdir -p "$ROOT/_diag"

PYSRC="C:/Python311/python.exe"          # 与主环境同为 3.11
VENV="$ROOT/.venv-cuda"
PIP="$VENV/Scripts/python.exe"
CUIDX="https://download.pytorch.org/whl/cu126"

if [ ! -x "$PIP" ]; then
  "$PYSRC" -m venv "$VENV" || exit 1
fi
# 幂等：万一 pip 被上面的坑搞没了，这行能救回来（只装不卸载）
"$PIP" -m ensurepip --default-pip || exit 1

echo "===== [1/3] torch 2.14.0+cu126（--no-deps，避免任何卸载） ====="
WHEEL="$ROOT/_diag/download/torch-2.14.0+cu126-cp311-cp311-win_amd64.whl"
if [ -f "$WHEEL" ]; then
  # 本地已有校验过的轮子就直接装。2.6GB 走 pip 流式下载，中途断一次就全白下。
  echo "使用本地已校验的轮子：$WHEEL"
  "$PIP" -m pip install --no-deps "$WHEEL" || exit 1
else
  "$PIP" -m pip install --no-deps --index-url "$CUIDX" "torch==2.14.0+cu126" || exit 1
fi

echo "===== [2/3] torch 的运行时依赖（cu 索引里没有，走默认镜像） ====="
"$PIP" -m pip install filelock typing-extensions sympy networkx jinja2 fsspec || exit 1

echo "===== [3/3] transformers / laya（对齐主环境版本） ====="
"$PIP" -m pip install "transformers==5.17.0" "laya==0.3.5" || exit 1

echo "===== 自检 ====="
"$PIP" - <<'PY'
import torch, transformers
print("torch       :", torch.__version__)
print("cuda build  :", torch.version.cuda)
print("available   :", torch.cuda.is_available())
if torch.cuda.is_available():
    p = torch.cuda.get_device_properties(0)
    print("device      :", torch.cuda.get_device_name(0))
    print("VRAM total  : %.2f GB" % (p.total_memory / 1024**3))
    print("capability  :", torch.cuda.get_device_capability(0))
print("transformers:", transformers.__version__)
PY
echo "===== DONE ====="
