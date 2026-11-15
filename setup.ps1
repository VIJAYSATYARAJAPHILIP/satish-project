$ErrorActionPreference = 'Stop'
$envPath = Join-Path $PSScriptRoot '.env'

if (Test-Path -LiteralPath $envPath) {
  throw 'A .env file already exists. Edit it directly if you need to change your settings.'
}

$securePassword = Read-Host 'Enter the owner password (at least 10 characters)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $ownerPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}

if ($ownerPassword.Length -lt 10) {
  $ownerPassword = $null
  throw 'Password must be at least 10 characters. Run setup again.'
}

$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$secretBytes = New-Object byte[] 32
$random.GetBytes($secretBytes)
$random.Dispose()
$sessionSecret = [BitConverter]::ToString($secretBytes).Replace('-', '').ToLowerInvariant()
$content = "OWNER_PASSWORD=$ownerPassword`nSESSION_SECRET=$sessionSecret`nPORT=3000`nDATA_DIR=./data`nUPLOADS_DIR=./uploads`n"
$encoding = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envPath, $content, $encoding)
$ownerPassword = $null
$sessionSecret = $null
$secretBytes = $null
Write-Host 'Created .env with your owner password and a generated session secret. Keep this file private.' -ForegroundColor Green
