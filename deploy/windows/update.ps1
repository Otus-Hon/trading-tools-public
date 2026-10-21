$ErrorActionPreference = "Stop"
Set-Location C:\TradingTools\app

& git.exe pull --ff-only
if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed; the running release was not changed." }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\deploy\windows\install.ps1
if ($LASTEXITCODE -ne 0) { throw "Build failed; scheduled tasks were not restarted." }

Restart-ScheduledTask -TaskName TradingToolsWorker
Restart-ScheduledTask -TaskName TradingToolsWeb
Start-Sleep -Seconds 8
Invoke-RestMethod http://127.0.0.1:3000/api/health -TimeoutSec 10
