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
$localUser = Get-LocalUser -Name $UserName -ErrorAction Stop
if (-not $localUser.Enabled) {
  Enable-LocalUser -Name $UserName
  $localUser = Get-LocalUser -Name $UserName -ErrorAction Stop
}
$administrators = Get-LocalGroup -SID "S-1-5-32-544"
$isAdministrator = Get-LocalGroupMember -Group $administrators -ErrorAction SilentlyContinue | Where-Object {
  $_.SID -and $_.SID.Value -eq $localUser.SID.Value
}
if ($isAdministrator) { throw "$account must not be a member of the local Administrators group." }

& (Join-Path $PSScriptRoot "set-service-account-rights.ps1") -UserName $UserName

$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$npmExecutable = (Get-Command npm.cmd -ErrorAction Stop).Source
$nodeVersion = (& $nodeExecutable --version).Trim()
if ($nodeVersion -ne "v22.23.0") { throw "The service runtime requires Node v22.23.0; found $nodeVersion." }
$escapedNodeExecutable = $nodeExecutable.Replace("'", "''")
$escapedNpmExecutable = $npmExecutable.Replace("'", "''")
Set-Content `
  -Path "C:\TradingTools\config\runtime-paths.ps1" `
  -Value @(
    "`$env:TRADING_TOOLS_NODE = '$escapedNodeExecutable'"
    "`$env:TRADING_TOOLS_NPM = '$escapedNpmExecutable'"
  ) `
  -Encoding ASCII

foreach ($target in @("C:\TradingTools\app", "C:\TradingTools\config", "C:\TradingTools\python")) {
  if (Test-Path $target) { & icacls.exe $target /grant "${account}:(OI)(CI)RX" /T /C | Out-Null }
}
foreach ($target in @("C:\TradingTools\data", "C:\TradingTools\logs")) {
  if (Test-Path $target) { & icacls.exe $target /grant "${account}:(OI)(CI)M" /T /C | Out-Null }
}

foreach ($credentialFile in @(Get-ChildItem "C:\TradingTools\config\*.credential.xml" -ErrorAction SilentlyContinue)) {
  & (Join-Path $PSScriptRoot "protect-service-credential.ps1") `
    -CredentialPath $credentialFile.FullName `
    -ServiceUser $UserName
}

Write-Host "$account is configured without administrator-group membership."
Write-Host "Pinned the service runtime to $nodeExecutable."
