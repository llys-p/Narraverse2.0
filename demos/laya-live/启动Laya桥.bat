@echo off
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
