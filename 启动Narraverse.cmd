@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start_l3_release.ps1"
if errorlevel 1 (
  echo Narraverse did not start. See the error above.
  pause
  exit /b 1
)
