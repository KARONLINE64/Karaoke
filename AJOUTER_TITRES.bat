@echo off
rem Double-clic : ajoute des titres au catalogue de la page karaoke.
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
where py >nul 2>nul
if %errorlevel%==0 (py -3 tools\ajouter_titres.py) else (python tools\ajouter_titres.py)
echo.
pause
