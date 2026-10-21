param([string]$ServiceUser = "TradingToolsSvc")

$ErrorActionPreference = "Stop"
$password = Read-Host "Password for the dedicated $ServiceUser account" -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new(".\$ServiceUser", $password)

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install.ps1")
if ($LASTEXITCODE -ne 0) { throw "Install/build failed." }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "setup-service-account.ps1") -UserName $ServiceUser -Password $password
if ($LASTEXITCODE -ne 0) { throw "Service-account setup failed." }
& (Join-Path $PSScriptRoot "register-task.ps1") -ServiceUser ".\$ServiceUser" -Credential $credential

Start-Sleep -Seconds 8
try {
  Invoke-RestMethod http://127.0.0.1:3000/api/health -TimeoutSec 10
} catch {
  Write-Warning "The worker may still be warming its empty data directory. Check C:\TradingTools\logs\worker.log."
}
Write-Host "Local deployment complete. Funnel remains disabled until publish-funnel.ps1 is run explicitly."
