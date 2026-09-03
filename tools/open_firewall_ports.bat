@echo off
chcp 65001 >nul
title Narraverse - LAN Access Setup
echo.
echo ============================================
echo   Narraverse LAN Access Setup
echo ============================================
echo.
echo [1/3] Adding port forwarding: 0.0.0.0:8081 -^> 127.0.0.1:8080
echo       (Denova only listens on 127.0.0.1, so we forward 8081 to it)
netsh interface portproxy add v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8080 connectaddress=127.0.0.1
echo.
echo [2/3] Removing old firewall rule...
netsh advfirewall firewall delete rule name="Narraverse LAN Access" >nul 2>&1
echo.
echo [3/3] Adding firewall rule for ports 8081,8097,8098...
netsh advfirewall firewall add rule name="Narraverse LAN Access" dir=in action=allow protocol=TCP localport=8081,8097,8098
echo.
echo ============================================
if %errorlevel%==0 (
  echo   [DONE] Setup complete.
  echo.
  echo   Next steps:
  echo   1. Fully close Narraverse/Denova, then restart
  echo   2. Connect phone to same WiFi
  echo   3. Open on phone: http://192.168.1.233:8081/?mode=narraverse
) else (
  echo   [FAILED] Please right-click this file and select
  echo   "Run as administrator".
)
echo ============================================
echo.
pause
