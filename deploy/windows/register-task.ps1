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

$localUserName = ($Credential.UserName -split "\\")[-1]
$localUser = Get-LocalUser -Name $localUserName -ErrorAction Stop
$administrators = Get-LocalGroup -SID "S-1-5-32-544"
$isAdministrator = Get-LocalGroupMember -Group $administrators -ErrorAction SilentlyContinue | Where-Object {
  $_.SID -and $_.SID.Value -eq $localUser.SID.Value
}
if ($isAdministrator) { throw "$($Credential.UserName) must not be an administrator." }

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

try {
  $verificationTask = "TradingToolsVerifyRuntime"
  $verificationScript = "C:\TradingTools\app\deploy\windows\verify-service-runtime.ps1"
  $verificationAction = New-ScheduledTaskAction `
    -Execute "PowerShell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$verificationScript`""
  Register-ScheduledTask `
    -TaskName $verificationTask `
    -Action $verificationAction `
    -User $Credential.UserName `
    -Password $plainPassword `
    -RunLevel Limited `
    -Settings $settings `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $verificationTask
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $verificationState = Get-ScheduledTask -TaskName $verificationTask
    $verificationInfo = Get-ScheduledTaskInfo -TaskName $verificationTask
    if ($verificationInfo.LastRunTime -gt [DateTime]::MinValue -and $verificationState.State -ne "Running") { break }
    Start-Sleep -Seconds 1
  }
  $verificationInfo = Get-ScheduledTaskInfo -TaskName $verificationTask
  if ($verificationInfo.LastTaskResult -ne 0) {
    throw "Low-privilege SQLite/data-directory verification failed with result $($verificationInfo.LastTaskResult). See C:\TradingTools\logs\service-runtime-check.log."
  }

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

    $registered = Get-ScheduledTask -TaskName $task.Name
    if ($registered.Principal.RunLevel -ne "Limited") { throw "$($task.Name) is not configured with limited privileges." }
    $principalSid = ([Security.Principal.NTAccount]$registered.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
    if ($principalSid -ne $localUser.SID.Value) { throw "$($task.Name) is not assigned to the dedicated service account." }
    Start-ScheduledTask -TaskName $task.Name
  }
} finally {
  Unregister-ScheduledTask -TaskName "TradingToolsVerifyRuntime" -Confirm:$false -ErrorAction SilentlyContinue
  $plainPassword = $null
}

Start-Sleep -Seconds 5
Get-ScheduledTask -TaskName "TradingTools*" | Select-Object TaskName, State
Write-Host "Low-privilege SQLite and private-data access check passed."
Write-Host "Logs: C:\TradingTools\logs\web.log and worker.log"
