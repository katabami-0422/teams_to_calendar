# Register a daily Windows Task Scheduler job that syncs Teams files to Google Calendar.
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File .\schedule.ps1
#   powershell -ExecutionPolicy Bypass -File .\schedule.ps1 -Hour 7 -Minute 30
# Remove:
#   Unregister-ScheduledTask -TaskName TeamsAssignmentsToGCal
param(
  [int]$Hour = 7,
  [int]$Minute = 30,
  [string]$TaskName = "TeamsAssignmentsToGCal"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
if (-not $node) { throw "node not found on PATH" }

$script = Join-Path $root "src\sync.js"
$action = New-ScheduledTaskAction -Execute $node -Argument ('"{0}"' -f $script) -WorkingDirectory $root

$start = (Get-Date).Date.AddHours($Hour).AddMinutes($Minute)
if ($start -lt (Get-Date)) { $start = $start.AddDays(1) }
$trigger = New-ScheduledTaskTrigger -Daily -At $start

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

$desc = "Sync Teams channel files to Google Calendar daily at " + $start.ToString("HH:mm")
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description $desc -Force

Write-Host ""
Write-Host ("Registered: {0} (daily {1})" -f $TaskName, $start.ToString("HH:mm"))
Write-Host ("Remove: Unregister-ScheduledTask -TaskName {0}" -f $TaskName)