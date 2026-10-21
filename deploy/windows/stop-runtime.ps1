param([string]$RepositoryRoot = "C:\TradingTools\app")

$ErrorActionPreference = "Stop"

foreach ($taskName in @("TradingToolsWeb", "TradingToolsWorker")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -ne "Disabled") {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Seconds 2

# A running Next.js/worker process keeps native .node modules locked on Windows.
# Limit termination to node.exe processes whose command line belongs to this app.
$appNodes = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine.IndexOf($RepositoryRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
foreach ($process in $appNodes) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}

for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
  $remaining = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($RepositoryRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($remaining.Count -eq 0) {
    Write-Host "Trading Tools runtime stopped; OpenD and unrelated processes were not changed."
    exit 0
  }
  Start-Sleep -Milliseconds 500
}

throw "Trading Tools Node processes are still running. No dependency files were changed."
