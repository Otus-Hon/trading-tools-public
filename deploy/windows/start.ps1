$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverRoot = "C:\TradingTools"
$configPath = Join-Path $serverRoot "config\production.ps1"
$logPath = Join-Path $serverRoot "logs\web.log"

if (-not (Test-Path $configPath)) {
  throw "Missing production configuration: $configPath"
}

New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null
. $configPath
Set-Location $repositoryRoot

"[$(Get-Date -Format o)] Starting Trading Tools" | Out-File -FilePath $logPath -Append
& npm.cmd start -- --hostname 127.0.0.1 --port $env:PORT *>> $logPath
exit $LASTEXITCODE
