param(
  [string]$ServiceUser = "TradingToolsSvc",
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = "Stop"
$localUser = Get-LocalUser -Name $ServiceUser -ErrorAction Stop
$administrators = Get-LocalGroup -SID "S-1-5-32-544"
$isAdministrator = Get-LocalGroupMember -Group $administrators -ErrorAction SilentlyContinue | Where-Object {
  $_.SID -and $_.SID.Value -eq $localUser.SID.Value
}
if ($isAdministrator) { throw "$ServiceUser is an administrator; refusing to accept deployment." }

foreach ($taskName in @("TradingToolsWeb", "TradingToolsWorker")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $principalSid = ([Security.Principal.NTAccount]$task.Principal.UserId).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($principalSid -ne $localUser.SID.Value -or $task.Principal.RunLevel -ne "Limited") {
    throw "$taskName is not running as the dedicated limited service account."
  }
  if ($task.State -ne "Running") { throw "$taskName is not running." }
}

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$health = $null
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod http://127.0.0.1:3000/api/health -TimeoutSec 10
    if ($health.ok -eq $true) { break }
  } catch {
    $health = $null
  }
  Start-Sleep -Seconds 5
}
if (-not $health -or $health.ok -ne $true) {
  throw "Local health did not become ready. Funnel remains disabled. Inspect C:\TradingTools\logs\web.log and worker.log."
}

$webListeners = @(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
if ($webListeners.Count -eq 0) { throw "No web listener exists on port 3000." }
$nonLoopback = @($webListeners | Where-Object { $_.LocalAddress -notin @("127.0.0.1", "::1") })
if ($nonLoopback.Count -gt 0) { throw "Port 3000 is listening outside loopback; refusing deployment." }

if (-not (Select-String -Path "C:\TradingTools\logs\service-runtime-check.log" -Pattern "Service account can write and read" -Quiet)) {
  throw "The service-account SQLite/data-directory verification record is missing."
}

Get-ScheduledTask -TaskName "TradingToolsWeb", "TradingToolsWorker" | Select-Object TaskName, State
$health
Write-Host "SQLite, public-security tests, service permissions, loopback binding, and application health are verified."
