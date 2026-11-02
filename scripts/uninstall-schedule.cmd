@echo off
rem Remove the unattended-publish tasks from Windows Task Scheduler.
setlocal
chcp 65001 >nul
schtasks /Delete /TN "\AutoPipeline\Publish-1020" /F
schtasks /Delete /TN "\AutoPipeline\Publish-1940" /F
echo.
echo Done (a "cannot find" message above just means that task was not registered).
endlocal
