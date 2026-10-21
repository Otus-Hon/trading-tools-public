param(
  [string]$UserName = "TradingToolsSvc",
  [Security.SecureString]$Password
)

$ErrorActionPreference = "Stop"
if (-not $Password) { $Password = Read-Host "Password for the dedicated $UserName account" -AsSecureString }

$existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Existing dedicated account found; updating its password and restrictions."
  Set-LocalUser -Name $UserName -Password $Password -PasswordNeverExpires $true -UserMayChangePassword $false
} else {
  New-LocalUser `
    -Name $UserName `
    -Password $Password `
    -AccountNeverExpires `
    -PasswordNeverExpires `
    -UserMayNotChangePassword `
    -Description "Limited Trading Tools web/worker account" | Out-Null
  Write-Host "Created the dedicated service account."
}

$account = "$env:COMPUTERNAME\$UserName"
$administrators = Get-LocalGroup -SID "S-1-5-32-544"
$isAdministrator = Get-LocalGroupMember -Group $administrators -ErrorAction SilentlyContinue | Where-Object {
  $_.SID -and $_.SID.Value -eq (Get-LocalUser -Name $UserName).SID.Value
}
if ($isAdministrator) { throw "$account must not be a member of the local Administrators group." }

foreach ($target in @("C:\TradingTools\app", "C:\TradingTools\config", "C:\TradingTools\python")) {
  if (Test-Path $target) { & icacls.exe $target /grant "${account}:(OI)(CI)RX" /T /C | Out-Null }
}
foreach ($target in @("C:\TradingTools\data", "C:\TradingTools\logs")) {
  if (Test-Path $target) { & icacls.exe $target /grant "${account}:(OI)(CI)M" /T /C | Out-Null }
}

Write-Host "$account is configured without administrator-group membership."
Write-Host "Deny this account local and Remote Desktop logon in Local Security Policy; keep 'Log on as a batch job' available."
