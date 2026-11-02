@echo off
rem ============================================================
rem  Unattended blog publish (called by Windows Task Scheduler, 2x/day)
rem  order: git pull -> npm ci (only if package-lock changed) -> run-blog-pipeline --auto
rem  log  : logs\scheduled-YYYYMMDD-HHmm.log
rem  Safety rules (daily cap 2, 1 post/run, login check, duplicates) live in
rem  src\utils\unattendedGuard.js and run inside run-blog-pipeline.js --auto.
rem ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

if not exist logs mkdir logs
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%t"
set "LOGFILE=logs\scheduled-%STAMP%.log"

call :main >> "%LOGFILE%" 2>&1
set "RC=%ERRORLEVEL%"
exit /b %RC%

:main
echo [%date% %time%] scheduled-publish start
set "NODE_NO_WARNINGS=1"

rem --- git pull (remember package-lock blob id before/after) ---
for /f %%h in ('git rev-parse HEAD:package-lock.json 2^>nul') do set "LOCK_BEFORE=%%h"
git pull origin main
if errorlevel 1 echo [warn] git pull failed - continuing with current code
for /f %%h in ('git rev-parse HEAD:package-lock.json 2^>nul') do set "LOCK_AFTER=%%h"

rem --- npm ci only when package-lock.json changed (or node_modules missing) ---
set "NEED_CI="
if not exist node_modules set "NEED_CI=1"
if not "%LOCK_BEFORE%"=="%LOCK_AFTER%" set "NEED_CI=1"
if defined NEED_CI (
  echo [info] package-lock changed or node_modules missing - npm ci
  call npm ci
  if errorlevel 1 (
    echo [error] npm ci failed - aborting this run
    exit /b 1
  )
) else (
  echo [info] package-lock unchanged - skip npm ci
)

node scripts\run-blog-pipeline.js --auto
set "RC=%ERRORLEVEL%"
if "%RC%"=="2" echo [LOGIN REQUIRED] Tistory login expired - run menu item 1 (blog login). See logs\login-required.log
echo [%date% %time%] scheduled-publish end (exit %RC%)
exit /b %RC%
