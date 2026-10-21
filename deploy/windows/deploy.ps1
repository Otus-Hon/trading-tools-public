param([string]$ServiceUser = "TradingToolsSvc")

$ErrorActionPreference = "Stop"
$password = Read-Host "Password for the dedicated $ServiceUser account" -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new(".\$ServiceUser", $password)

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1")
if ($LASTEXITCODE -ne 0) { throw "Install/build failed." }
& (Join-Path $PSScriptRoot "setup-service-account.ps1") -UserName $ServiceUser -Password $password
& (Join-Path $PSScriptRoot "register-task.ps1") -ServiceUser ".\$ServiceUser" -Credential $credential
& (Join-Path $PSScriptRoot "verify-deployment.ps1") -ServiceUser $ServiceUser
Write-Host "Local deployment verified. Funnel remains disabled until publish-funnel.ps1 is run explicitly."
