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

The deployment generates a random 48-character password for the dedicated account. It is never displayed, logged, or placed on a process command line. A DPAPI-encrypted `PSCredential` is saved at `C:\TradingTools\config\TradingToolsSvc.credential.xml`, restricted to local Administrators and SYSTEM; `TradingToolsSvc` cannot read that file. Task Scheduler receives the credential through its PowerShell API. Use `-RotateServicePassword` to replace it or `-PromptForPassword` only when manual entry is explicitly desired. The installer grants only the required batch-logon right and explicitly denies local and Remote Desktop logon for this identity. The web task listens on `127.0.0.1:3000`; the independent worker performs provider refreshes. Both run with limited privileges and restart after failures.

The installer stops only the `TradingToolsWeb`/`TradingToolsWorker` tasks and app-scoped Node processes before changing native modules. It does not stop or reinstall OpenD, Tailscale, the existing Python environment when healthy, or unrelated applications. Runtime databases, configuration, and logs remain outside the checkout. An exact already-verified release skips npm installation and rebuilding.

Before accepting a deployment, the scripts verify all of the following on Windows:

- `better-sqlite3` loads in a fresh Node 22.23.0 process and completes a real query;
- the public-security integration suite passes;
- the dedicated service identity is not an administrator and both tasks have `Limited` run level;
- that identity can load SQLite and write/read the private data directory;
- both tasks start, the application reaches ready health, and port 3000 listens only on loopback.

If any check fails, deployment stops and Funnel remains disabled.

The installer configures `TradingToolsSvc` with **Log on as a batch job**, denies **Log on locally** and **Log on through Remote Desktop Services**, and verifies that an actual task can execute. Do not add it to Administrators. A domain policy that denies batch logon can override local policy; deployment detects that by refusing to accept a task that never executes.

## Verify

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
Get-Content C:\TradingTools\logs\web.log -Tail 100
Get-Content C:\TradingTools\logs\worker.log -Tail 100
Get-ScheduledTask -TaskName "TradingTools*" | Select-Object TaskName,State
& C:\TradingTools\python\.venv\Scripts\python.exe C:\TradingTools\app\verify_futu_opend.py
```

## Historical money-flow baseline

The CITIC endpoints publish a rolling recent window, so the repository includes the non-private verified baseline directly in `lib/moneyFlowSeed.js`. A new VPS database automatically receives 211 long rows (`2025-12-09`–`2026-10-20`) and 112 short rows (`2026-05-11`–`2026-10-20`) on first application access. No seed-file download or manual import is required; later five-minute provider refreshes update overlaps and append new dates.

The legacy importer remains available only for operators with an additional trusted custom history beyond the versioned baseline:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\TradingTools\app\deploy\windows\import-money-flow.ps1 -SeedPath "$env:USERPROFILE\Downloads\TradingTools-money-flow-seed.sqlite"
```

The optional importer moves the seed into `C:\TradingTools\imports`, restricts the import and backup directories to Administrators and SYSTEM, validates SQLite integrity, dates, values, and CITIC source identity, creates an online backup, inserts only dates absent from the VPS, records the seed SHA-256 and coverage, checks the running APIs expose every row, and reruns the complete deployment/security gate. Existing VPS rows win on overlapping dates. The public worker continues five-minute provider upserts into the same `C:\TradingTools\data\market.sqlite` source of truth.

Do not add inbound Windows Firewall rules for 3000 or 11111. Confirm `Get-NetTCPConnection -State Listen` shows both bound to loopback.

## Publish with Tailscale Funnel

Only after the local health and security tests pass:

```powershell
powershell -ExecutionPolicy Bypass -File C:\TradingTools\app\deploy\windows\publish-funnel.ps1
```

This publishes only `127.0.0.1:3000` on HTTPS port 443. It does not expose future loopback services. Funnel requires MagicDNS, tailnet HTTPS, and the Funnel node attribute. It only provides a hostname in the tailnet's `*.ts.net` domain, only supports public ports 443, 8443, and 10000, and has non-configurable bandwidth limits. On one VPS hostname, additional apps require a different supported public port or path mount; independent custom hostnames and many public apps are where a conventional reverse proxy or separate Tailscale nodes becomes justified. See the current [Tailscale Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel).

The publisher reruns the complete local deployment gate immediately before exposure. It refuses to enable Funnel unless SQLite/runtime access, limited task identities, task state, application health, the unique service-account verification record, and loopback-only port binding all pass again.

Disable publication without stopping the private app:

```powershell
tailscale funnel --https=443 off
```

## Update only Trading Tools

```powershell
powershell -ExecutionPolicy Bypass -File C:\TradingTools\app\deploy\windows\update.ps1
```

The updater uses `git pull --ff-only`, rebuilds, and restarts only `TradingToolsWeb` and `TradingToolsWorker`. It does not restart OpenD, Tailscale, or unrelated applications.

## Repair or redeploy safely

From Administrator PowerShell, this single command downloads the reviewed release and runs the complete private deployment gate:

```powershell
Set-Location C:\TradingTools\app; git pull --ff-only; if ($LASTEXITCODE -eq 0) { powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\deploy.ps1 }
```

No password prompt is required by default. Publication is still a separate explicit action.

If installation completed through the final SQLite check but account setup rejected the password, pull the latest scripts and resume without reinstalling or rebuilding:

```powershell
Set-Location C:\TradingTools\app; git pull --ff-only; if ($LASTEXITCODE -eq 0) { powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\deploy.ps1 -Resume }
```

Resume is accepted only when the completed build stamp and dependency lock match, no application build input changed, the production build exists, and SQLite still loads. A deployment-script/documentation-only update is allowed. If Windows rejects an automatically generated credential, deployment generates another without displaying it; the server policy is never weakened.

### Windows failure causes addressed

- Native `.node` files cannot be replaced while the existing Next.js/worker processes hold them open. The installer now stops only app-scoped processes before `npm ci`, eliminating the SWC `EPERM` and stale SQLite binary.
- The production configuration sets `NODE_ENV=production`; dependency installation now explicitly includes locked development dependencies needed to compile TypeScript and Tailwind, then prunes them after the verified build.
- SQLite is rechecked in a fresh Node process after rebuild, so a prior failed native-module load cannot contaminate verification in the repair process.
- The security test launches Next directly with `node.exe`; it no longer asks Node to spawn the Windows `npm.cmd` shim, which caused `spawn EINVAL`.
- `SecureString` values stay in one PowerShell runspace. Passing one through `powershell.exe -File` converted it to the literal string `System.Security.SecureString`.
- The service identity receives the required batch-logon right automatically and is denied interactive/RDP logon. Startup pins the absolute verified Node 22.23.0 and npm executables, sets its own runtime path, and retains the npm-script SQLite preflight instead of depending on the administrator account's environment.

## Add another application later

1. Assign a separate folder, data/config/log paths, service identity, and loopback port.
2. Create its own startup and worker Scheduled Tasks; never reuse Trading Tools configuration or credentials.
3. Verify it locally and decide explicitly whether it should be private with Tailscale Serve or public with Funnel.
4. Do not change the Trading Tools Funnel mapping when publishing another app. If the three allowed Funnel ports or path routing are no longer sufficient, introduce a reverse proxy only then.

## Recovery

- Web failure: inspect `web.log`, then run `Stop-ScheduledTask TradingToolsWeb; Start-ScheduledTask TradingToolsWeb`.
- Data delay: inspect `worker.log`, verify OpenD on loopback, then run `Stop-ScheduledTask TradingToolsWorker; Start-ScheduledTask TradingToolsWorker`.
- Bad release: check out the previous known-good public commit, rerun `install.ps1`, and restart only the two Trading Tools tasks. Do not delete `C:\TradingTools\data` or `C:\TradingTools\config`.
