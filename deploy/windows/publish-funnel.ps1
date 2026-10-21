param([int]$PublicPort = 443)

$ErrorActionPreference = "Stop"
if ($PublicPort -notin @(443, 8443, 10000)) { throw "Tailscale Funnel only supports public ports 443, 8443, and 10000." }

$health = Invoke-RestMethod http://127.0.0.1:3000/api/health -TimeoutSec 10
if (-not $health.ok) { throw "Local health check did not pass; Funnel was not enabled." }
& tailscale.exe funnel --bg --https=$PublicPort http://127.0.0.1:3000
if ($LASTEXITCODE -ne 0) { throw "Tailscale Funnel configuration failed." }
& tailscale.exe funnel status
