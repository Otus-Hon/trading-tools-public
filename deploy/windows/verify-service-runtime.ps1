$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configPath = "C:\TradingTools\config\production.ps1"
$logPath = "C:\TradingTools\logs\service-runtime-check.log"

if (-not (Test-Path $configPath)) { throw "Missing production configuration: $configPath" }
. $configPath
$env:TRADING_TOOLS_PUBLIC_MODE = "1"
$env:NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE = "1"
Set-Location $repositoryRoot

& node.exe .\scripts\verify_runtime_access.js *>&1 | Set-Content -Path $logPath
exit $LASTEXITCODE
