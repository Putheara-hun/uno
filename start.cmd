@echo off
rem Double-click to start RaDrop. Keep this window open while you play.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download it from https://nodejs.org and try again.
  pause
  exit /b 1
)
set RADROP_OPEN=1
node server.js
pause
