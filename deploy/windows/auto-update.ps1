param([switch]$Force)

$ErrorActionPreference = "Stop"
$serverRoot = "C:\TradingTools"
$repositoryRoot = Join-Path $serverRoot "app"
$logPath = Join-Path $serverRoot "logs\auto-update.log"
$mutex = New-Object System.Threading.Mutex($false, "Global\TradingToolsAutoUpdate")
$hasLock = $false

try {
  $hasLock = $mutex.WaitOne(0)
  if (-not $hasLock) { return }
  New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null
  "[$(Get-Date -Format o)] Checking origin/main" | Out-File -FilePath $logPath -Append
  & (Join-Path $repositoryRoot "deploy\windows\update.ps1") -Force:$Force *>> $logPath
  "[$(Get-Date -Format o)] Update check completed" | Out-File -FilePath $logPath -Append
} catch {
  "[$(Get-Date -Format o)] Update failed: $($_.Exception.Message)" | Out-File -FilePath $logPath -Append
  throw
} finally {
  if ($hasLock) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
