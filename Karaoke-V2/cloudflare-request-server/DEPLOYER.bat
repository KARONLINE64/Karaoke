@echo off
rem Double-clic : met en ligne le serveur des demandes du KJ propriétaire (cloudflare-request-server).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployer.ps1"
echo.
pause
