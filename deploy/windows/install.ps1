$ErrorActionPreference = "Stop"

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$serverRoot = "C:\TradingTools"
$configPath = Join-Path $serverRoot "config\production.ps1"
$pythonPath = Join-Path $serverRoot "python\.venv\Scripts\python.exe"
$releaseStampPath = Join-Path $serverRoot "config\installed-release.txt"

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
  if ($LASTEXITCODE -ne 0) { throw "Python virtual-environment creation failed." }
}

& $pythonPath -c "import futu, tzdata" 2>$null
if ($LASTEXITCODE -ne 0) {
  & $pythonPath -m pip install -r (Join-Path $repositoryRoot "requirements-futu.txt")
  if ($LASTEXITCODE -ne 0) { throw "Futu Python dependency installation failed." }
} else {
  Write-Host "Existing Futu Python environment is healthy; skipping reinstall."
}

if (-not (Test-Path $configPath)) {
  Copy-Item (Join-Path $PSScriptRoot "production.example.ps1") $configPath
  Write-Host "Created $configPath"
}

. $configPath
$env:TRADING_TOOLS_PUBLIC_MODE = "1"
$env:NEXT_PUBLIC_TRADING_TOOLS_PUBLIC_MODE = "1"
Set-Location $repositoryRoot

& (Join-Path $PSScriptRoot "stop-runtime.ps1") -RepositoryRoot $repositoryRoot

$lockHash = (Get-FileHash (Join-Path $repositoryRoot "package-lock.json") -Algorithm SHA256).Hash
$releaseId = (& git.exe rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to identify the checked-out release." }
$expectedStamp = "$releaseId $lockHash"
$installedStamp = if (Test-Path $releaseStampPath) { (Get-Content $releaseStampPath -Raw).Trim() } else { "" }
$releaseHealthy = $false
if ((Test-Path (Join-Path $repositoryRoot ".next\BUILD_ID")) -and $installedStamp -eq $expectedStamp) {
  & node.exe .\scripts\ensure_sqlite_binding.js --probe-only
  $releaseHealthy = $LASTEXITCODE -eq 0
}

if (-not $releaseHealthy) {
  & npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw "npm clean install failed. Trading Tools tasks remain stopped." }
  & npm.cmd run ensure:sqlite
  if ($LASTEXITCODE -ne 0) { throw "SQLite ABI verification failed." }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed." }
} else {
  Write-Host "This exact release and its SQLite binding are healthy; skipping npm reinstall and rebuild."
}

& npm.cmd run test:public-security
if ($LASTEXITCODE -ne 0) { throw "Public-security integration tests failed." }
& npm.cmd audit --omit=dev --audit-level=high
if ($LASTEXITCODE -ne 0) { throw "Production dependency audit failed." }
if (-not $releaseHealthy) {
  & npm.cmd prune --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "Production dependency pruning failed." }
}
& npm.cmd run ensure:sqlite
if ($LASTEXITCODE -ne 0) { throw "SQLite failed after production dependency pruning." }
Set-Content -Path $releaseStampPath -Value $expectedStamp -Encoding ASCII

Write-Host ""
Write-Host "Trading Tools build, SQLite check, and public-security tests passed."
