@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install it from https://nodejs.org/ then run this again.
  pause
  exit /b 1
)

node launch.js
pause
