param(
  [string]$ServiceUser = "TradingToolsSvc",
  [string]$CredentialPath = "C:\TradingTools\config\TradingToolsSvc.credential.xml",
  [switch]$Rotate
)

$ErrorActionPreference = "Stop"

function Get-CryptoIndex([int]$Maximum, [Security.Cryptography.RandomNumberGenerator]$Generator) {
  if ($Maximum -le 0 -or $Maximum -gt 256) { throw "Invalid password alphabet size." }
  $sample = New-Object byte[] 1
  $limit = 256 - (256 % $Maximum)
  do { $Generator.GetBytes($sample) } while ($sample[0] -ge $limit)
  return $sample[0] % $Maximum
}

function New-CryptoPassword {
  $upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"
  $lower = "abcdefghijkmnopqrstuvwxyz"
  $digits = "23456789"
  $symbols = "!#%+,-.:=?@_"
  $all = $upper + $lower + $digits + $symbols
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $characters = New-Object 'System.Collections.Generic.List[char]'
    foreach ($alphabet in @($upper, $lower, $digits, $symbols)) {
      $characters.Add($alphabet[(Get-CryptoIndex $alphabet.Length $generator)])
    }
    while ($characters.Count -lt 48) {
      $characters.Add($all[(Get-CryptoIndex $all.Length $generator)])
    }
    for ($index = $characters.Count - 1; $index -gt 0; $index -= 1) {
      $swapIndex = Get-CryptoIndex ($index + 1) $generator
      $temporary = $characters[$index]
      $characters[$index] = $characters[$swapIndex]
      $characters[$swapIndex] = $temporary
    }
    return -join $characters
  } finally {
    $generator.Dispose()
  }
}

if ((Test-Path $CredentialPath) -and -not $Rotate) {
  try {
    $credential = Import-Clixml -Path $CredentialPath
  } catch {
    throw "The encrypted service credential cannot be opened by this Windows administrator. Rerun with -RotateServicePassword to create a new one."
  }
  if ($credential -isnot [System.Management.Automation.PSCredential]) {
    throw "The encrypted service credential file is invalid."
  }
  if (($credential.UserName -split "\\")[-1] -ne $ServiceUser) {
    throw "The encrypted credential belongs to a different service account."
  }
  Write-Host "Loaded the existing Windows-encrypted service credential."
  return $credential
}

$plainPassword = New-CryptoPassword
try {
  $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
  $credential = [System.Management.Automation.PSCredential]::new(".\$ServiceUser", $securePassword)
} finally {
  $plainPassword = $null
}

$parent = Split-Path $CredentialPath
New-Item -ItemType Directory -Force -Path $parent | Out-Null
$credential | Export-Clixml -Path $CredentialPath -Force
& (Join-Path $PSScriptRoot "protect-service-credential.ps1") `
  -CredentialPath $CredentialPath `
  -ServiceUser $ServiceUser
Write-Host "Generated and saved a Windows-encrypted service credential; no password was displayed."
return $credential
