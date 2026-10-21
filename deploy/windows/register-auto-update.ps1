param(
  [int]$IntervalMinutes = 2,
  [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = "Stop"
if ($IntervalMinutes -lt 1) { throw "IntervalMinutes must be at least 1." }
if (-not $Credential) {
  $defaultUser = "$env:USERDOMAIN\$env:USERNAME"
  $Credential = Get-Credential -UserName $defaultUser -Message "Administrator credentials for the Trading Tools automatic deployment task"
}
$plainPassword = $Credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($plainPassword)) { throw "A task-account password is required." }
$scriptPath = "C:\TradingTools\app\deploy\windows\auto-update.ps1"
if (-not (Test-Path $scriptPath)) { throw "Missing automatic updater: $scriptPath" }

$action = New-ScheduledTaskAction `
  -Execute "PowerShell.exe" `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`""
$trigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask `
  -TaskName "TradingToolsAutoUpdate" `
  -Description "Checks origin/main and builds Trading Tools only when the deployed commit changes." `
  -Action $action `
  -Trigger $trigger `
  -User $Credential.UserName `
  -Password $plainPassword `
  -RunLevel Highest `
  -Settings $settings `
  -Force | Out-Null

Start-ScheduledTask -TaskName "TradingToolsAutoUpdate"
Get-ScheduledTask -TaskName "TradingToolsAutoUpdate" | Select-Object TaskName, State
Write-Host "Automatic update checks run every $IntervalMinutes minute(s)."
Write-Host "Log: C:\TradingTools\logs\auto-update.log"
