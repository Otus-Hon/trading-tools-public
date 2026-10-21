param(
  [Parameter(Mandatory = $true)][string]$CredentialPath,
  [string]$ServiceUser = "TradingToolsSvc"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $CredentialPath)) { throw "Credential file does not exist: $CredentialPath" }

# Restrict the DPAPI ciphertext to local Administrators and SYSTEM. The service
# identity can read production.ps1 but must not be able to read its credential.
& icacls.exe $CredentialPath /inheritance:r /grant:r `
  "*S-1-5-32-544:(F)" `
  "*S-1-5-18:(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to restrict the service credential ACL." }
$serviceAccount = Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue
if ($serviceAccount) {
  & icacls.exe $CredentialPath /remove:g "*$($serviceAccount.SID.Value)" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Unable to remove service-account access from its credential file." }
}
