$ErrorActionPreference = "Stop"

function Set-InstallProgress([int]$Percent, [string]$Status) {
  Write-Progress -Activity "Building Trading Tools" -Status $Status -PercentComplete $Percent
}

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
Set-InstallProgress 5 "Checking the pinned runtime"

$nodeVersion = (& node --version).Trim()
if ($nodeVersion -ne "v22.23.0") {
  throw "Node v22.23.0 is required; found $nodeVersion."
}

if (-not (Test-Path $pythonPath)) {
  Set-InstallProgress 10 "Creating the Python environment"
  & python -m venv (Join-Path $serverRoot "python\.venv")
  if ($LASTEXITCODE -ne 0) { throw "Python virtual-environment creation failed." }
}

& $pythonPath -c "import futu, tzdata" 2>$null
if ($LASTEXITCODE -ne 0) {
  Set-InstallProgress 16 "Installing Python/Futu dependencies"
  & $pythonPath -m pip install -r (Join-Path $repositoryRoot "requirements-futu.txt")
  if ($LASTEXITCODE -ne 0) { throw "Futu Python dependency installation failed." }
} else {
  Set-InstallProgress 16 "Python dependencies are healthy"
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
Set-InstallProgress 24 "Checking whether this release is already built"

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
  # production.ps1 sets NODE_ENV=production before this point. npm otherwise
  # omits TypeScript, Tailwind/PostCSS, and other build-only dependencies.
  Set-InstallProgress 34 "Installing locked Node dependencies"
  & npm.cmd ci --include=dev
  if ($LASTEXITCODE -ne 0) { throw "npm clean install failed. Trading Tools tasks remain stopped." }
  & npm.cmd run ensure:sqlite
  if ($LASTEXITCODE -ne 0) { throw "SQLite ABI verification failed." }
  Set-InstallProgress 55 "Compiling the production dashboard"
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed." }
} else {
  Set-InstallProgress 70 "Exact release already built - reusing it"
  Write-Host "This exact release and its SQLite binding are healthy; skipping npm reinstall and rebuild."
}

Set-InstallProgress 76 "Running public-security integration tests"
& npm.cmd run test:public-security
if ($LASTEXITCODE -ne 0) { throw "Public-security integration tests failed." }
& npm.cmd run test:backtest-storage
if ($LASTEXITCODE -ne 0) { throw "Backtest storage policy test failed." }
& npm.cmd run test:windows-auto-update
if ($LASTEXITCODE -ne 0) { throw "Windows automatic-update contract test failed." }
Set-InstallProgress 84 "Auditing production dependencies"
& npm.cmd audit --omit=dev --audit-level=high
if ($LASTEXITCODE -ne 0) { throw "Production dependency audit failed." }
if (-not $releaseHealthy) {
  Set-InstallProgress 91 "Pruning build-only packages"
  & npm.cmd prune --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "Production dependency pruning failed." }
}
& npm.cmd run ensure:sqlite
if ($LASTEXITCODE -ne 0) { throw "SQLite failed after production dependency pruning." }
Set-Content -Path $releaseStampPath -Value $expectedStamp -Encoding ASCII
Set-InstallProgress 100 "Build complete"
Write-Progress -Activity "Building Trading Tools" -Completed

Write-Host ""
Write-Host "Trading Tools build, SQLite check, and public-security tests passed."
