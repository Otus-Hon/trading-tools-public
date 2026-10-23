param([switch]$Force)

$ErrorActionPreference = "Stop"
$repositoryRoot = "C:\TradingTools\app"
Set-Location $repositoryRoot

function Invoke-DeploymentGit {
  & git.exe -c "safe.directory=$repositoryRoot" @args
}

function Set-UpdateProgress([int]$Percent, [string]$Status) {
  Write-Progress -Activity "Updating Trading Tools" -Status $Status -PercentComplete $Percent
}

Set-UpdateProgress 5 "Checking GitHub for a new commit"
$trackedChanges = @(Invoke-DeploymentGit status --porcelain --untracked-files=no)
if ($LASTEXITCODE -ne 0) { throw "Unable to inspect the deployment checkout." }
if ($trackedChanges.Count -gt 0) { throw "Tracked local changes exist; refusing to overwrite them." }
$currentCommit = (Invoke-DeploymentGit rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to read the deployed commit." }
Invoke-DeploymentGit fetch --quiet origin main
if ($LASTEXITCODE -ne 0) { throw "Unable to fetch origin/main; the running release was not changed." }
$targetCommit = (Invoke-DeploymentGit rev-parse origin/main).Trim()
if ($LASTEXITCODE -ne 0) { throw "Unable to read origin/main." }

$releaseStampPath = "C:\TradingTools\config\installed-release.txt"
$buildIdPath = Join-Path $repositoryRoot ".next\BUILD_ID"
$lockHash = (Get-FileHash (Join-Path $repositoryRoot "package-lock.json") -Algorithm SHA256).Hash
$expectedStamp = "$currentCommit $lockHash"
$installedStamp = if (Test-Path $releaseStampPath) { (Get-Content $releaseStampPath -Raw).Trim() } else { "" }
$installedReleaseIsCurrent = (Test-Path $buildIdPath) -and $installedStamp -eq $expectedStamp

if (-not $Force -and $currentCommit -eq $targetCommit -and $installedReleaseIsCurrent) {
  Set-UpdateProgress 100 "Already current - installed release verified"
  Write-Progress -Activity "Updating Trading Tools" -Completed
  Write-Host "Trading Tools source and installed release are current at $currentCommit. No build was run."
  return
}

if ($currentCommit -ne $targetCommit) {
  Invoke-DeploymentGit merge-base --is-ancestor $currentCommit $targetCommit
  if ($LASTEXITCODE -ne 0) { throw "origin/main is not a fast-forward from the deployed commit; update stopped." }
  Set-UpdateProgress 18 "Downloading the new source"
  Invoke-DeploymentGit pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed; the running release was not changed." }
  if ((Invoke-DeploymentGit rev-parse HEAD).Trim() -ne $targetCommit) { throw "The checkout did not reach the expected GitHub commit." }
} else {
  Set-UpdateProgress 18 "Source is current - repairing the incomplete installed release"
  Write-Host "Source is current at $currentCommit, but the installed release stamp or build is incomplete. Continuing with build and verification."
}

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
