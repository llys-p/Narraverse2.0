#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成『启动Laya桥.bat』的脚本。改文案请改这里再重跑，不要手改 .bat。

为什么必须用脚本生成：
  CMD 按 OEM 代码页（中文 Windows = 936/GBK）逐行解析 .bat。
  存成 UTF-8 时中文字节被误读，碎片可能落在行首被当成命令执行，
  报出「'鎶?JSON' 不是内部或外部命令」这类错。
  所以：GBK 无 BOM + 中文只出现在 echo/rem/title 行。

    python _gen_bat.py
"""
import io
import os

BAT = "启动Laya桥.bat"

# 页面改用桥自己的 /demo 路由打开，不再直接 start 本地 .html：
# 本地文件是 opaque origin，跨源 fetch 到 127.0.0.1 的行为各浏览器不一致；
# 走 http 同源就没这个问题，也不需要额外起静态服务器。
CONTENT = r"""@echo off
chcp 936 >nul
title Laya Bridge
cd /d "%~dp0"

echo ============================================
echo   Narraverse x Laya 决策桥
echo ============================================
echo.

rem ---- 端口占用保护 ----
netstat -ano | findstr ":8130 " | findstr LISTENING >nul
if %errorlevel%==0 (
  echo  [提示] 8130 端口已在监听，桥应该已经在运行
  echo         正在打开对话页面...
  echo.
  start "" "http://127.0.0.1:8130/demo"
  pause
  exit /b 0
)

rem ---- Python 三级探测，不写死托管目录 ----
set "PY="
if exist "%~dp0.venv\Scripts\python.exe" set "PY=%~dp0.venv\Scripts\python.exe"
if not defined PY (
  for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
)
if not defined PY (
  for /f "delims=" %%i in ('where py 2^>nul') do if not defined PY set "PY=%%i"
)
if not defined PY (
  echo.
  echo  [错误] 找不到 Python，请先安装 Python 3.10 或更新版本
  echo.
  pause
  exit /b 1
)

echo   使用解释器: %PY%
echo   桥地址:     http://127.0.0.1:8130
echo   演示页:     http://127.0.0.1:8130/demo
echo.
echo   首次启动要加载检查点（约 840MB），需要 40~70 秒，请等页面自己出来。
echo   只有 3GB 左右空闲内存时不要同时跑两个检查点，会直接崩溃（无报错）。
echo.
echo   未安装 Laya 时会自动降级到回退引擎，仍可正常对话。
echo   想用真实 Laya 推理: %PY% -m pip install laya
echo.

set OPEN_BROWSER=1
chcp 65001 >nul
"%PY%" laya_bridge.py

chcp 936 >nul
echo.
echo  桥已停止
pause
"""


def main():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), BAT)
    with io.open(path, "w", encoding="gbk", newline="\r\n") as f:
        f.write(CONTENT)
    raw = open(path, "rb").read()
    # 自检：能且仅能用 GBK 解、无 BOM、中文只出现在 echo/rem/title 行
    txt = raw.decode("gbk")
    try:
        raw.decode("utf-8")
        print("[warn] 也是合法 UTF-8，检查是否有意外字符")
    except Exception:
        print("[ok] GBK 唯一解")
    print("[ok] BOM:", raw[:3] == b"\xef\xbb\xbf", "（应为 False）")
    bad = [i for i, l in enumerate(txt.splitlines(), 1)
           if any(ord(c) > 127 for c in l)
           and not l.strip().lower().startswith(("echo", "rem", "title"))]
    print("[ok] 非 echo/rem/title 行含中文的行号:", bad, "（应为空）")
    print("已生成:", path, len(raw), "bytes")


if __name__ == "__main__":
    main()
