$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverRoot = "C:\TradingTools"
$configPath = Join-Path $serverRoot "config\production.ps1"
$runtimePath = Join-Path $serverRoot "config\runtime-paths.ps1"
$logPath = Join-Path $serverRoot "logs\worker.log"

if (-not (Test-Path $configPath)) { throw "Missing production configuration: $configPath" }
if (-not (Test-Path $runtimePath)) { throw "Missing pinned runtime configuration: $runtimePath" }
New-Item -ItemType Directory -Force -Path (Split-Path $logPath) | Out-Null
. $configPath
. $runtimePath
if (-not (Test-Path $env:TRADING_TOOLS_NODE) -or -not (Test-Path $env:TRADING_TOOLS_NPM)) {
  throw "Pinned Node/npm runtime is unavailable."
}
$env:PATH = "$(Split-Path $env:TRADING_TOOLS_NODE);$env:PATH"
$env:TRADING_TOOLS_PUBLIC_MODE = "1"
$env:NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE = "1"
$env:TRADING_TOOLS_REFRESH_WORKER = "1"
Set-Location $repositoryRoot

if ((Test-Path $logPath) -and (Get-Item $logPath).Length -gt 10MB) {
  Move-Item $logPath "$logPath.1" -Force
}
"[$(Get-Date -Format o)] Starting Trading Tools data worker" | Out-File -FilePath $logPath -Append
& $env:TRADING_TOOLS_NODE .\scripts\ensure_sqlite_binding.js --probe-only *>> $logPath
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $env:TRADING_TOOLS_NPM run worker:public *>> $logPath
exit $LASTEXITCODE
