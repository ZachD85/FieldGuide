@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py atriguide_launcher.py
) else (
  python atriguide_launcher.py
)
if errorlevel 1 pause
