@echo off
rem Remove the unattended-publish tasks from Windows Task Scheduler.
setlocal
chcp 65001 >nul
schtasks /Delete /TN "\AutoPipeline\Publish-0920" /F
schtasks /Delete /TN "\AutoPipeline\Publish-1720" /F
rem previous schedule (10:20 / 19:40), if still registered
schtasks /Delete /TN "\AutoPipeline\Publish-1020" /F
schtasks /Delete /TN "\AutoPipeline\Publish-1940" /F
echo.
echo Done (a "cannot find" message above just means that task was not registered).
endlocal
