[CmdletBinding()]
param(
  [string]$AppRoot = 'C:\VaultBack',
  [string]$ManifestUrl = 'https://github.com/dr-rei/VaultBack/releases/latest/download/latest.json',
  [string]$Pm2App = 'vaultback'
)

$ErrorActionPreference = 'Stop'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('vaultback-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $installer = Join-Path $temp 'install-release.mjs'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/dr-rei/VaultBack/main/scripts/install-release.mjs' -OutFile $installer
  & node $installer --app-root $AppRoot --manifest-url $ManifestUrl --pm2-app $Pm2App
  if ($LASTEXITCODE -ne 0) { throw "VaultBack installer exited with code $LASTEXITCODE." }
} finally {
  Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
