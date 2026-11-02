# Register 2 daily tasks in Windows Task Scheduler (10:20, 19:40 PC local time = KST).
# - runs only while the user is logged on (Interactive; Tistory cookies / .env live in the user's PC)
# - WakeToRun: wake the PC from sleep
# - StartWhenAvailable: if the PC was off at the time, run once when it is back
# Called by install-schedule.cmd. Uninstall with uninstall-schedule.cmd.
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'scheduled-publish.cmd'
$folder = '\AutoPipeline\'
$times  = @{ 'Publish-1020' = '10:20'; 'Publish-1940' = '19:40' }

$user      = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries `
              -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 3)
$action    = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"`"$script`"`"" -WorkingDirectory $root

foreach ($name in $times.Keys) {
  $trigger = New-ScheduledTaskTrigger -Daily -At $times[$name]
  Register-ScheduledTask -TaskName $name -TaskPath $folder -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null
  Write-Host "registered: $folder$name  daily $($times[$name])"
}
Write-Host ''
Write-Host 'Done. Check: Task Scheduler > AutoPipeline folder, or  schtasks /Query /TN \AutoPipeline\Publish-1020'
Write-Host 'NOTE: times are PC local time. The PC time zone must be KST (UTC+9).'
