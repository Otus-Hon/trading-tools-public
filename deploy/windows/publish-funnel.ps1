param(
  [int]$PublicPort = 443,
  [string]$ServiceUser = "TradingToolsSvc"
)

$ErrorActionPreference = "Stop"
if ($PublicPort -notin @(443, 8443, 10000)) { throw "Tailscale Funnel only supports public ports 443, 8443, and 10000." }

& (Join-Path $PSScriptRoot "verify-deployment.ps1") -ServiceUser $ServiceUser
Write-Host "Complete local deployment and security gate passed; enabling only the loopback web endpoint."
& tailscale.exe funnel --bg --https=$PublicPort http://127.0.0.1:3000
if ($LASTEXITCODE -ne 0) { throw "Tailscale Funnel configuration failed." }
& tailscale.exe funnel status
if ($LASTEXITCODE -ne 0) { throw "Funnel was configured, but its status could not be verified." }
Write-Host "Trading Tools is public through Tailscale Funnel. No Windows inbound port was opened."
