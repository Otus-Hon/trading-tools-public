$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverRoot = "C:\TradingTools"
$configPath = Join-Path $serverRoot "config\production.ps1"
$logPath = Join-Path $serverRoot "logs\worker.log"

if (-not (Test-Path $configPath)) { throw "Missing production configuration: $configPath" }
New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null
. $configPath
$env:TRADING_TOOLS_PUBLIC_MODE = "1"
$env:NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE = "1"
$env:TRADING_TOOLS_REFRESH_WORKER = "1"
Set-Location $repositoryRoot

if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 10MB) {
  Move-Item $logPath "$logPath.1" -Force
}
"[$(Get-Date -Format o)] Starting Trading Tools data worker" | Out-File -FilePath $logPath -Append
& npm.cmd run worker:public *>> $logPath
exit $LASTEXITCODE
