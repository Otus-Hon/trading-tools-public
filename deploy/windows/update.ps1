param([switch]$Force)

$ErrorActionPreference = "Stop"
Set-Location C:\TradingTools\app

function Set-UpdateProgress([int]$Percent, [string]$Status) {
  Write-Progress -Activity "Updating Trading Tools" -Status $Status -PercentComplete $Percent
}

Set-UpdateProgress 5 "Checking GitHub for a new commit"
$trackedChanges = @(& git.exe status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the deployment checkout." }
if ($trackedChanges.Count -gt 0) { throw "Tracked local changes exist; refusing to overwrite them." }
$currentCommit = (& git.exe rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to read the deployed commit." }
& git.exe fetch --quiet origin main
if ($LASTEXITCODE -ne 0) { throw "Unable to fetch origin/main; the running release was not changed." }
$targetCommit = (& git.exe rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to read origin/main." }

if (-not $Force -and $currentCommit -eq $targetCommit) {
  Set-UpdateProgress 100 "Already current - no build required"
  Write-Progress -Activity "Updating Trading Tools" -Completed
  Write-Host "Trading Tools is already current at $currentCommit. No build was run."
  return
}

& git.exe merge-base --is-ancestor $currentCommit $targetCommit
if ($LASTEXITCODE -ne 0) { throw "origin/main is not a fast-forward from the deployed commit; update stopped." }
Set-UpdateProgress 18 "Downloading the new source"
& git.exe pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed; the running release was not changed." }
if ((& git.exe rev-parse HEAD).Trim() -ne $targetCommit) { throw "The checkout did not reach the expected GitHub commit." }

Set-UpdateProgress 30 "Building and testing the new release"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1
if ($LASTEXITCODE -ne 0) { throw "Build failed; scheduled tasks were not restarted." }

Set-UpdateProgress 88 "Restarting the web and data worker"
foreach ($taskName in @("TradingToolsWorker", "TradingToolsWeb")) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $taskName
}
Set-UpdateProgress 94 "Waiting for health and security checks"
& .\deploy\windows\verify-deployment.ps1
Set-UpdateProgress 100 "Deployment healthy at $targetCommit"
Write-Progress -Activity "Updating Trading Tools" -Completed
