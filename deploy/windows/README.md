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

## Install the application

Clone this repository into `C:\TradingTools\app`, then run in Administrator PowerShell:

```powershell
Set-Location C:\TradingTools\app
powershell -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1
powershell -ExecutionPolicy Bypass -File .\deploy\windows\register-task.ps1
```

The installer creates an isolated Python environment, installs `requirements-futu.txt`, runs `npm ci`, runs the SQLite ABI preflight, and builds the production application. The scheduled task runs the application as `SYSTEM` at startup on `127.0.0.1:3000`.

## Verify

```powershell
Invoke-WebRequest http://127.0.0.1:3000 -UseBasicParsing
Get-Content C:\TradingTools\logs\web.log -Tail 100
& C:\TradingTools\python\.venv\Scripts\python.exe C:\TradingTools\app\verify_futu_opend.py
```

Do not expose ports 3000 or 11111 directly to the internet. Add a TLS reverse proxy after the local application and OpenD checks pass.
