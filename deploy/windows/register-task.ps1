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
$taskUser = $localUser.SID.Translate([Security.Principal.NTAccount]).Value
$taskUserSid = ([Security.Principal.NTAccount]$taskUser).Translate([Security.Principal.SecurityIdentifier]).Value
if ($taskUserSid -ne $localUser.SID.Value) {
  throw "Task Scheduler identity resolution did not return the dedicated local service account."
}
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
  $verificationLog = "C:\TradingTools\logs\service-runtime-check.log"
  $verificationId = [Guid]::NewGuid().ToString("N")
  Remove-Item $verificationLog -Force -ErrorAction SilentlyContinue
  $verificationAction = New-ScheduledTaskAction `
    -Execute "PowerShell.exe" `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$verificationScript`" -VerificationId $verificationId"
  Register-ScheduledTask `
    -TaskName $verificationTask `
    -Action $verificationAction `
    -User $taskUser `
    -Password $plainPassword `
    -RunLevel Limited `
    -Settings $settings `
    -Force | Out-Null
  $verificationRequestedAt = Get-Date
  Start-ScheduledTask -TaskName $verificationTask
  $verificationCompleted = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    $verificationState = Get-ScheduledTask -TaskName $verificationTask
    $verificationInfo = Get-ScheduledTaskInfo -TaskName $verificationTask
    if ($verificationInfo.LastRunTime -ge $verificationRequestedAt.AddSeconds(-2) -and $verificationState.State -notin @("Running", "Queued")) {
      $verificationCompleted = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  $verificationState = Get-ScheduledTask -TaskName $verificationTask
  $verificationInfo = Get-ScheduledTaskInfo -TaskName $verificationTask
  $verificationResultHex = "0x{0:X8}" -f [uint32]$verificationInfo.LastTaskResult
  if (-not $verificationCompleted) {
    throw "The limited-account verification task did not start and finish within 60 seconds (state $($verificationState.State), result $verificationResultHex). Confirm that local or domain policy does not deny this account batch logon. Funnel remains disabled."
  }
  if ($verificationInfo.LastTaskResult -ne 0) {
    throw "The limited-account runtime check failed with result $verificationResultHex. See C:\TradingTools\logs\service-runtime-check.log. Funnel remains disabled."
  }
  if (-not (Test-Path $verificationLog) -or -not (Select-String -Path $verificationLog -Pattern "^VerificationId=$verificationId$" -Quiet)) {
    throw "The limited-account runtime check did not produce its unique success record. Funnel remains disabled."
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
      -User $taskUser `
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
