@echo off
title Narraverse 2.0 Launcher
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup_narraverse2.ps1"
if errorlevel 1 (
  echo.
  echo Narraverse setup or start failed. Check the message above and tools\logs.
  pause
)
