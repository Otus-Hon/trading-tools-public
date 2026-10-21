# Windows Server deployment

This deployment keeps source, generated data, runtime configuration, and Futu OpenD separate:

```text
C:\TradingTools\app       public Git checkout
C:\TradingTools\data      fresh private runtime databases and caches
C:\TradingTools\config    VPS-only environment configuration
C:\TradingTools\opend     Futu OpenD installation and configuration
C:\TradingTools\python    VPS-only Python virtual environment
C:\TradingTools\logs      process logs
```

Do not upload an existing private-data archive. The empty `data` directory is populated from fresh provider fetches.

## Prerequisites

- Windows Server 2022 x64
- Node.js 22.23.0
- Git for Windows
- Python 3.12
- Futu OpenD logged in and listening only on `127.0.0.1:11111`

OpenD and the Python package are separate requirements. OpenD is the gateway process. The official `futu-api` Python package is the client used by the application's bridge scripts.

Each future application should use its own top-level folder, Windows identity or narrowly scoped ACLs, process/task, logs, data directory, and loopback port. For example: Trading Tools `127.0.0.1:3000`, another website `127.0.0.1:3001`, and an API `127.0.0.1:8000`. Never bind an application to `0.0.0.0` merely to use Funnel.

## Install without publishing

Clone this repository into `C:\TradingTools\app`, then run in Administrator PowerShell:

```powershell
Set-Location C:\TradingTools\app
powershell -ExecutionPolicy Bypass -File .\deploy\windows\deploy.ps1
```

The account and task scripts prompt for the dedicated account password. The password is passed to Windows Task Scheduler and is not written to the repository or `production.ps1`. The web task listens on `127.0.0.1:3000`; the independent worker performs provider refreshes. Both run with limited privileges and restart after failures.

In Local Security Policy, deny `TradingToolsSvc` **Log on locally** and **Log on through Remote Desktop Services**. Do not add it to Administrators. Preserve **Log on as a batch job** so Task Scheduler can start it.

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
Get-Content C:\TradingTools\logs\web.log -Tail 100
Get-Content C:\TradingTools\logs\worker.log -Tail 100
Get-ScheduledTask -TaskName "TradingTools*" | Select-Object TaskName,State
& C:\TradingTools\python\.venv\Scripts\python.exe C:\TradingTools\app\verify_futu_opend.py
```

Do not add inbound Windows Firewall rules for 3000 or 11111. Confirm `Get-NetTCPConnection -State Listen` shows both bound to loopback.

## Publish with Tailscale Funnel

Only after the local health and security tests pass:

```powershell
powershell -ExecutionPolicy Bypass -File C:\TradingTools\app\deploy\windows\publish-funnel.ps1
```

This publishes only `127.0.0.1:3000` on HTTPS port 443. It does not expose future loopback services. Funnel requires MagicDNS, tailnet HTTPS, and the Funnel node attribute. It only provides a hostname in the tailnet's `*.ts.net` domain, only supports public ports 443, 8443, and 10000, and has non-configurable bandwidth limits. On one VPS hostname, additional apps require a different supported public port or path mount; independent custom hostnames and many public apps are where a conventional reverse proxy or separate Tailscale nodes becomes justified. See the current [Tailscale Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel).

Disable publication without stopping the private app:

```powershell
tailscale funnel --https=443 off
```

## Update only Trading Tools

```powershell
powershell -ExecutionPolicy Bypass -File C:\TradingTools\app\deploy\windows\update.ps1
```

The updater uses `git pull --ff-only`, rebuilds, and restarts only `TradingToolsWeb` and `TradingToolsWorker`. It does not restart OpenD, Tailscale, or unrelated applications.

## Add another application later

1. Assign a separate folder, data/config/log paths, service identity, and loopback port.
2. Create its own startup and worker Scheduled Tasks; never reuse Trading Tools configuration or credentials.
3. Verify it locally and decide explicitly whether it should be private with Tailscale Serve or public with Funnel.
4. Do not change the Trading Tools Funnel mapping when publishing another app. If the three allowed Funnel ports or path routing are no longer sufficient, introduce a reverse proxy only then.

## Recovery

- Web failure: inspect `web.log`, then `Restart-ScheduledTask TradingToolsWeb`.
- Data delay: inspect `worker.log`, verify OpenD on loopback, then `Restart-ScheduledTask TradingToolsWorker`.
- Bad release: check out the previous known-good public commit, rerun `install.ps1`, and restart only the two Trading Tools tasks. Do not delete `C:\TradingTools\data` or `C:\TradingTools\config`.
