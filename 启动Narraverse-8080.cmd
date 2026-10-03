@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start_formal_8080.ps1"
if errorlevel 1 pause
