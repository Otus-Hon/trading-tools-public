param(
  [string]$UserName = "TradingToolsSvc",
  [Security.SecureString]$Password
)

$ErrorActionPreference = "Stop"
if (-not $Password) { $Password = Read-Host "Password for the dedicated $UserName account" -AsSecureString }

$existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if ($existing) {
  Set-LocalUser -Name $UserName -Password $Password -PasswordNeverExpires $true -UserMayChangePassword $false
} else {
  New-LocalUser `
    -Name $UserName `
    -Password $Password `
    -AccountNeverExpires `
    -PasswordNeverExpires `
    -UserMayNotChangePassword `
    -Description "Low-privilege Trading Tools web and data worker account" | Out-Null
}

$account = "$env:COMPUTERNAME\$UserName"
foreach ($target in @("C:\TradingTools\app", "C:\TradingTools\config", "C:\TradingTools\python")) {
  if (Test-Path $target) { & icacls.exe $target /grant "${account}:(OI)(CI)RX" /T /C | Out-Null }
}
foreach ($target in @("C:\TradingTools\data", "C:\TradingTools\logs")) {
  if (Test-Path $target) { & icacls.exe $target /grant "${account}:(OI)(CI)M" /T /C | Out-Null }
}

Write-Host "$account is configured without administrator-group membership."
Write-Host "Deny this account local and Remote Desktop logon in Local Security Policy; keep 'Log on as a batch job' available."
