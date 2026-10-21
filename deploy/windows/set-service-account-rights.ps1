param([string]$UserName = "TradingToolsSvc")

$ErrorActionPreference = "Stop"
$localUser = Get-LocalUser -Name $UserName -ErrorAction Stop
$principal = "*$($localUser.SID.Value)"
$temporaryRoot = Join-Path $env:TEMP "trading-tools-rights-$([Guid]::NewGuid().ToString('N'))"
$exportPath = Join-Path $temporaryRoot "current.inf"
$templatePath = Join-Path $temporaryRoot "service-rights.inf"
$databasePath = Join-Path $temporaryRoot "service-rights.sdb"
$logPath = Join-Path $temporaryRoot "secedit.log"

function Get-RightEntries([string[]]$Lines, [string]$RightName) {
  $line = $Lines | Where-Object { $_ -match "^$([Regex]::Escape($RightName))\s*=" } | Select-Object -First 1
  if (-not $line) { return @() }
  $value = ($line -split "=", 2)[1].Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { return @() }
  return @($value -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Format-Right([string]$Name, [string[]]$Entries) {
  return "$Name = $($Entries -join ',')"
}

try {
  New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
  & secedit.exe /export /cfg $exportPath /areas user_rights /quiet
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $exportPath)) {
    throw "Unable to read the current local user-rights policy."
  }
  $current = Get-Content $exportPath

  $batch = @(Get-RightEntries $current "SeBatchLogonRight" | Where-Object { $_ -ne $principal }) + $principal
  $denyBatch = @(Get-RightEntries $current "SeDenyBatchLogonRight" | Where-Object { $_ -ne $principal })
  $denyInteractive = @(Get-RightEntries $current "SeDenyInteractiveLogonRight" | Where-Object { $_ -ne $principal }) + $principal
  $denyRemoteInteractive = @(Get-RightEntries $current "SeDenyRemoteInteractiveLogonRight" | Where-Object { $_ -ne $principal }) + $principal

  @(
    "[Unicode]"
    "Unicode=yes"
    "[Version]"
    'signature="$CHICAGO$"'
    "Revision=1"
    "[Privilege Rights]"
    (Format-Right "SeBatchLogonRight" $batch)
    (Format-Right "SeDenyBatchLogonRight" $denyBatch)
    (Format-Right "SeDenyInteractiveLogonRight" $denyInteractive)
    (Format-Right "SeDenyRemoteInteractiveLogonRight" $denyRemoteInteractive)
  ) | Set-Content -Path $templatePath -Encoding Unicode

  & secedit.exe /validate $templatePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "The service-account rights template did not validate." }
  & secedit.exe /configure /db $databasePath /cfg $templatePath /overwrite /areas user_rights /log $logPath /quiet
  if ($LASTEXITCODE -ne 0) { throw "Unable to apply the dedicated service-account logon rights." }
} finally {
  if (Test-Path $temporaryRoot) { Remove-Item $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "$env:COMPUTERNAME\$UserName may log on only as a batch task, not locally or through Remote Desktop."
