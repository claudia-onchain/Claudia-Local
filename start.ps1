# start.ps1: install and build if needed, then start Claudia Local on 127.0.0.1 and open it in your browser.
# Same as start.sh, for PowerShell. Data lives in $HOME\.claudia-local, not in this folder.
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
$ok = $false
if ($node) { $v = [version]((node -p "process.versions.node").Trim()); $ok = $v -ge [version]"22.13.0" }
if (-not $ok) { Write-Error "Claudia Local needs Node.js 22.13 or newer: https://nodejs.org (LTS)"; exit 1 }

if (-not (Test-Path node_modules)) { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
if (-not (Test-Path dashboard\dist\index.html)) { npm run build; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
node bin\claudia-local.js @args
exit $LASTEXITCODE
