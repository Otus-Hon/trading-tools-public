param(
  [string]$ServiceUser = ".\TradingToolsSvc",
  [System.Management.Automation.PSCredential]$Credential
)

$ErrorActionPreference = "Stop"
if ($ServiceUser -match "(?i)SYSTEM|Administrator") { throw "Use the dedicated, non-administrator TradingToolsSvc account." }
if (-not $Credential) {
  $Credential = Get-Credential -UserName $ServiceUser -Message "Credentials for the Trading Tools scheduled tasks"
}
$plainPassword = $Credential.GetNetworkCredential().Password
if ([string]::IsNullOrWhiteSpace($plainPassword)) { throw "A service-account password is required by Task Scheduler." }

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -AtStartup
$tasks = @(
  @{ Name = "TradingToolsWeb"; Script = "C:\TradingTools\app\deploy\windows\start.ps1" },
  @{ Name = "TradingToolsWorker"; Script = "C:\TradingTools\app\deploy\windows\start-worker.ps1" }
)

foreach ($task in $tasks) {
  if (-not (Test-Path $task.Script)) { throw "Missing startup script: $($task.Script)" }
  $action = New-ScheduledTaskAction `
    -Execute "PowerShell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$($task.Script)`""
  Register-ScheduledTask `
    -TaskName $task.Name `
    -Action $action `
    -Trigger $trigger `
    -User $Credential.UserName `
    -Password $plainPassword `
    -RunLevel Limited `
    -Settings $settings `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $task.Name
}

Start-Sleep -Seconds 5
Get-ScheduledTask -TaskName "TradingTools*" | Select-Object TaskName, State
Write-Host "Logs: C:\TradingTools\logs\web.log and worker.log"
