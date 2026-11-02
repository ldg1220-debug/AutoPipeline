@echo off
rem Register the unattended-publish tasks (10:20 and 19:40 daily) in Windows Task Scheduler.
rem Run from the user account that holds the Tistory login + .env (no admin rights needed).
setlocal
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-schedule.ps1"
if errorlevel 1 (
  echo [error] registration failed - see the message above
  exit /b 1
)
echo.
echo Logs: logs\scheduled-YYYYMMDD-HHmm.log   Login expired: logs\login-required.log
endlocal
