param(
  [string]$ServiceUser = "TradingToolsSvc",
  [switch]$Resume,
  [switch]$RotateServicePassword,
  [switch]$PromptForPassword
)

$ErrorActionPreference = "Stop"

if ($Resume) {
  $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
  $stampPath = "C:\TradingTools\config\installed-release.txt"
  if (-not (Test-Path $stampPath) -or -not (Test-Path (Join-Path $repositoryRoot ".next\BUILD_ID"))) {
    throw "No completed build stamp exists. Run deploy.ps1 without -Resume."
  }

  $stampParts = (Get-Content $stampPath -Raw).Trim() -split "\s+", 2
  if ($stampParts.Count -ne 2) { throw "The completed build stamp is invalid. Run a full deployment." }
  $installedCommit = $stampParts[0]
  $installedLockHash = $stampParts[1]
  $currentLockHash = (Get-FileHash (Join-Path $repositoryRoot "package-lock.json") -Algorithm SHA256).Hash
  if ($installedLockHash -ne $currentLockHash) { throw "Dependencies changed after the completed build. Run a full deployment." }

  Set-Location $repositoryRoot
  & git.exe cat-file -e "$installedCommit^{commit}"
  if ($LASTEXITCODE -ne 0) { throw "The completed build commit is unavailable. Run a full deployment." }
  $buildInputs = @(
    ".nvmrc", "app", "components", "lib", "public", "scripts", "package.json", "package-lock.json",
    "next.config.ts", "postcss.config.mjs", "tailwind.config.js", "tsconfig.json", "proxy.ts"
  )
  & git.exe diff --quiet $installedCommit HEAD -- @buildInputs
  if ($LASTEXITCODE -eq 1) { throw "Application build inputs changed. Run deploy.ps1 without -Resume." }
  if ($LASTEXITCODE -ne 0) { throw "Unable to verify the completed build against the current checkout." }
  & node.exe .\scripts\ensure_sqlite_binding.js --probe-only
  if ($LASTEXITCODE -ne 0) { throw "SQLite verification failed. Run a full deployment." }
  Write-Host "Completed build, dependency lock, unchanged application inputs, and SQLite binding verified; resuming at service-account setup."
} else {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Install/build failed." }
}

$credential = $null
$credentialPath = "C:\TradingTools\config\$ServiceUser.credential.xml"
for ($attempt = 1; $attempt -le 3; $attempt += 1) {
  if ($PromptForPassword) {
    $password = Read-Host "Password for the dedicated $ServiceUser account" -AsSecureString
    $candidate = [System.Management.Automation.PSCredential]::new(".\$ServiceUser", $password)
  } else {
    $rotateThisAttempt = $RotateServicePassword -or $attempt -gt 1
    $candidate = & (Join-Path $PSScriptRoot "get-service-credential.ps1") `
      -ServiceUser $ServiceUser `
      -CredentialPath $credentialPath `
      -Rotate:$rotateThisAttempt
    $password = $candidate.Password
  }
  try {
    & (Join-Path $PSScriptRoot "setup-service-account.ps1") -UserName $ServiceUser -Password $password
    $credential = $candidate
    if ($PromptForPassword) {
      $credential | Export-Clixml -Path $credentialPath -Force
      & (Join-Path $PSScriptRoot "protect-service-credential.ps1") `
        -CredentialPath $credentialPath `
        -ServiceUser $ServiceUser
    }
    break
  } catch {
    $passwordRejected = $_.FullyQualifiedErrorId -match "InvalidPassword" -or $_.Exception.GetType().Name -match "InvalidPassword"
    $password = $null
    $candidate = $null
    if (-not $passwordRejected -or $attempt -eq 3) { throw }
    if ($PromptForPassword) {
      Write-Warning "Windows rejected that password under the server's password policy. Enter a different strong password; it was not stored or logged."
    } else {
      Write-Warning "Windows rejected the generated password. Generating a different strong credential without displaying it."
    }
  }
}
if (-not $credential) { throw "The dedicated service account was not configured." }

& (Join-Path $PSScriptRoot "register-task.ps1") -ServiceUser ".\$ServiceUser" -Credential $credential
& (Join-Path $PSScriptRoot "verify-deployment.ps1") -ServiceUser $ServiceUser
$credential = $null
Write-Host "Local deployment verified. Funnel remains disabled until publish-funnel.ps1 is run explicitly."
