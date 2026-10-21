$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverRoot = "C:\TradingTools"
$configPath = Join-Path $serverRoot "config\production.ps1"
$pythonPath = Join-Path $serverRoot "python\.venv\Scripts\python.exe"

New-Item -ItemType Directory -Force -Path `
  (Join-Path $serverRoot "data"), `
  (Join-Path $serverRoot "config"), `
  (Join-Path $serverRoot "logs"), `
  (Join-Path $serverRoot "opend"), `
  (Join-Path $serverRoot "python") | Out-Null

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -ne "v22.23.0") {
  throw "Node v22.23.0 is required; found $nodeVersion."
}

if (-not (Test-Path $pythonPath)) {
  & python -m venv (Join-Path $serverRoot "python\.venv")
}

& $pythonPath -m pip install --upgrade pip
& $pythonPath -m pip install -r (Join-Path $repositoryRoot "requirements-futu.txt")

if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $PSScriptRoot "production.example.ps1") $configPath
  Write-Host "Created $configPath"
}

. $configPath
$env:TRADING_TOOLS_PUBLIC_MODE = "1"
$env:NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE = "1"
Set-Location $repositoryRoot
& npm.cmd ci
& npm.cmd run build
& npm.cmd run test:public-security
& npm.cmd audit --omit=dev --audit-level=high
& npm.cmd prune --omit=dev

Write-Host ""
Write-Host "Trading Tools is built. Next run:"
Write-Host "powershell -ExecutionPolicy Bypass -File C:\TradingTools\app\deploy\windows\register-task.ps1"
