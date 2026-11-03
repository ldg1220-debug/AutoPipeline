# Register 2 daily tasks in Windows Task Scheduler (09:20, 17:20 PC local time = KST).
# - runs only while the user is logged on (Interactive; Tistory cookies / .env live in the user's PC)
# - WakeToRun: wake the PC from sleep
# - StartWhenAvailable: if the PC was off at the time, run once when it is back
# Called by install-schedule.cmd. Uninstall with uninstall-schedule.cmd.
$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'scheduled-publish.cmd'
$folder = '\AutoPipeline\'
$times  = @{ 'Publish-0920' = '09:20'; 'Publish-1720' = '17:20' }

# remove the previous schedule (10:20 / 19:40) if it was registered, so posts are not published at old times too
foreach ($old in @('Publish-1020', 'Publish-1940')) {
  Unregister-ScheduledTask -TaskName $old -TaskPath '\AutoPipeline\' -Confirm:$false -ErrorAction SilentlyContinue
}

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
Write-Host 'Done. Check: Task Scheduler > AutoPipeline folder, or  schtasks /Query /TN \AutoPipeline\Publish-0920'
Write-Host 'NOTE: times are PC local time. The PC time zone must be KST (UTC+9).'
