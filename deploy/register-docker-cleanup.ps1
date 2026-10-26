# Registers the weekly Docker clean-up as a Windows scheduled task.
# Run ONCE in an elevated (Administrator) PowerShell on the box:
#     powershell -ExecutionPolicy Bypass -File .\register-docker-cleanup.ps1
# Sunday 04:00 local time (the quietest hour). Remove with:
#     Unregister-ScheduledTask -TaskName 'servd Docker clean-up' -Confirm:$false
$script = Join-Path $PSScriptRoot 'docker-cleanup.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'servd Docker clean-up' -Action $action -Trigger $trigger `
  -Settings $settings -RunLevel Highest -Force `
  -Description 'Weekly: prune unused Docker images / build cache older than 7 days. Never volumes.'
Write-Host 'Registered. Test now with: Start-ScheduledTask -TaskName "servd Docker clean-up"; log: deploy\docker-cleanup.log'
