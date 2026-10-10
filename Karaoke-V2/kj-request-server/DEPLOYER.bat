@echo off
rem Double-clic : met en ligne le serveur des espaces KJ (karolive-kj).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deployer.ps1"
echo.
pause
