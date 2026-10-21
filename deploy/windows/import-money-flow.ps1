param([Parameter(Mandatory = $true)][string]$SeedPath)

$ErrorActionPreference = "Stop"
$resolvedSeed = (Resolve-Path $SeedPath -ErrorAction Stop).Path
$configPath = "C:\TradingTools\config\production.ps1"
$runtimePath = "C:\TradingTools\config\runtime-paths.ps1"
$backupPath = "C:\TradingTools\backups"
$importPath = "C:\TradingTools\imports"

if (-not (Test-Path $configPath) -or -not (Test-Path $runtimePath)) {
  throw "Trading Tools production configuration is incomplete."
}
. $configPath
. $runtimePath
if (-not (Test-Path $env:TRADING_TOOLS_NODE)) { throw "Pinned Node runtime is unavailable." }

New-Item -ItemType Directory -Force -Path $importPath | Out-Null
& icacls.exe $importPath /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to protect the private seed-import directory." }
$resolvedImportPath = (Resolve-Path $importPath -ErrorAction Stop).Path.TrimEnd("\") + "\"
if (-not $resolvedSeed.StartsWith($resolvedImportPath, [StringComparison]::OrdinalIgnoreCase)) {
  $privateSeed = Join-Path $importPath "money-flow-seed-$([Guid]::NewGuid().ToString('N')).sqlite"
  Move-Item -LiteralPath $resolvedSeed -Destination $privateSeed
  $resolvedSeed = (Resolve-Path $privateSeed -ErrorAction Stop).Path
}
& icacls.exe $importPath /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to protect the private seed file." }

New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
& icacls.exe $backupPath /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to protect the private database-backup directory." }
$env:TRADING_TOOLS_BACKUP_DIR = $backupPath

$resultText = @(& $env:TRADING_TOOLS_NODE (Join-Path $PSScriptRoot "import-money-flow.js") $resolvedSeed 2>&1)
if ($LASTEXITCODE -ne 0) { throw "Money-flow import failed: $($resultText -join ' ')" }
$result = $resultText[-1] | ConvertFrom-Json
if (-not $result.ok) { throw "Money-flow import did not report success." }

$long = Invoke-RestMethod http://127.0.0.1:3000/api/moneyflow/long -TimeoutSec 20
$short = Invoke-RestMethod http://127.0.0.1:3000/api/moneyflow/short -TimeoutSec 20
if ($long.row_count -lt $result.final_long_rows -or $short.row_count -lt $result.final_short_rows) {
  throw "The running application did not expose every imported SQLite row."
}

& (Join-Path $PSScriptRoot "verify-deployment.ps1") -ServiceUser "TradingToolsSvc"
Write-Host "Private money-flow history merged and verified."
Write-Host "Long: $($long.row_count) rows ($($result.long_min_date) to $($result.long_max_date))"
Write-Host "Short: $($short.row_count) rows ($($result.short_min_date) to $($result.short_max_date))"
Write-Host "Pre-import database backup: $($result.backup_path)"
Write-Host "Persistent history baseline: $($result.history_floor_path)"
Write-Host "The original seed remains at $resolvedSeed; remove it after confirming the chart if no longer needed."
