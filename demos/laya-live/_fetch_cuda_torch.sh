#!/usr/bin/env bash
# 稳稳当当地把 torch cu126 的轮子拉下来。
#
# 为什么不用 pip 直接装：2.6GB 走 pip 一次流式下载，中途 SSL EOF 就整个白下，
# 而且 pip 不会续传，重来一次还是 2.6GB。这里用 curl -C - 断点续传 + sha256 校验。
set -u
ROOT="C:/Users/11/WorkBuddy/2026-09-23-11-11-35/laya-live"
cd "$ROOT" || exit 1
mkdir -p "$ROOT/_diag/download"

URL="https://download.pytorch.org/whl/cu126/torch-2.14.0%2Bcu126-cp311-cp311-win_amd64.whl"
DEST="$ROOT/_diag/download/torch-2.14.0+cu126-cp311-cp311-win_amd64.whl"
EXPECT="d3ab36375a5a459a85c1b183832dcba83ce569596004ff7991a3ae5b62e4ae51"
EXPECT_MB=2603

for attempt in $(seq 1 20); do
  have=0
  [ -f "$DEST" ] && have=$(( $(stat -c %s "$DEST" 2>/dev/null || echo 0) / 1048576 ))
  echo "--- 第 $attempt 次尝试，已有 ${have}MB / ${EXPECT_MB}MB ---"

  # --continue-at - 续传；--retry-all-errors 让 curl 自己扛住瞬时断连
  curl -L -C - --retry 8 --retry-all-errors --retry-delay 5 \
       --connect-timeout 30 --speed-time 60 --speed-limit 50000 \
       -o "$DEST" "$URL"
  rc=$?

  if [ -f "$DEST" ]; then
    got=$(sha256sum "$DEST" | cut -d' ' -f1)
    if [ "$got" = "$EXPECT" ]; then
      echo "✅ 校验通过：$got"
      echo "$DEST"
      exit 0
    fi
    size=$(( $(stat -c %s "$DEST") / 1048576 ))
    echo "   校验未过（rc=$rc，${size}MB）"
    # 文件已经够大但哈希不对 → 字节被污染了，续传没意义，只能重下
    if [ "$size" -ge "$((EXPECT_MB - 5))" ]; then
      echo "   体积够但哈希不符 → 丢弃重下"
      rm -f "$DEST"
    fi
  fi
  sleep 8
done

echo "❌ 20 次尝试仍未拿到完整轮子"
exit 1
