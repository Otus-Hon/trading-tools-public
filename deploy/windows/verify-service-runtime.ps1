param([Parameter(Mandatory = $true)][string]$VerificationId)

$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$configPath = "C:\TradingTools\config\production.ps1"
$runtimePath = "C:\TradingTools\config\runtime-paths.ps1"
$logPath = "C:\TradingTools\logs\service-runtime-check.log"

if (-not (Test-Path $configPath)) { throw "Missing production configuration: $configPath" }
if (-not (Test-Path $runtimePath)) { throw "Missing pinned runtime configuration: $runtimePath" }
. $configPath
. $runtimePath
if (-not (Test-Path $env:TRADING_TOOLS_NODE)) { throw "Pinned Node runtime is unavailable." }
$env:TRADING_TOOLS_PUBLIC_MODE = "1"
$env:NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE = "1"
Set-Location $repositoryRoot

$output = & $env:TRADING_TOOLS_NODE .\scripts\verify_runtime_access.js 2>&1
$nodeExitCode = $LASTEXITCODE
@("VerificationId=$VerificationId") + @($output) | Set-Content -Path $logPath
exit $nodeExitCode
