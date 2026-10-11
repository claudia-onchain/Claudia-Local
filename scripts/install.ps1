# Install Claudia Local (Windows PowerShell).   irm https://useclaudia.xyz/install.ps1 | iex
#
# What this does, in order:
#   1. checks that Node.js 22.13 or newer is installed (it never installs Node for you);
#   2. runs `npm install -g claudia-local`; if that fails, it clones
#      github.com/claudia-onchain/Claudia-Local into $HOME\claudia-local and builds it;
#   3. starts Claudia Local, which opens http://127.0.0.1:3939 in your browser.
# Your data lives in $HOME\.claudia-local. Nothing else on your computer is changed.
# (Everything runs inside one function and uses `return`, so piping into iex never closes your window.)
function Install-ClaudiaLocal {
  $Repo = "https://github.com/claudia-onchain/Claudia-Local.git"
  $Dir = if ($env:CLAUDIA_LOCAL_SRC) { $env:CLAUDIA_LOCAL_SRC } else { Join-Path $HOME "claudia-local" }
  $NeedNode = "Claudia Local needs Node.js 22.13 or newer.`nGet the LTS from https://nodejs.org, or:  winget install OpenJS.NodeJS.LTS`nThen open a new PowerShell window and run this installer again."

  if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Host $NeedNode; return }
  $v = [version]((node -p "process.versions.node").Trim())
  if ($v -lt [version]"22.13.0") { Write-Host $NeedNode; return }
  Write-Host "Node $v found."

  npm install -g claudia-local --no-audit --no-fund
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Installed. Starting Claudia Local (Ctrl+C stops it; run 'claudia-local' to start it again)."
    claudia-local
    return
  }

  Write-Host "npm install -g didn't work; building from source in $Dir instead."
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host "That needs git: https://git-scm.com"; return }
  if (Test-Path (Join-Path $Dir ".git")) { git -C $Dir pull --ff-only } else { git clone --depth 1 $Repo $Dir }
  if ($LASTEXITCODE) { return }
  Push-Location -LiteralPath $Dir
  try {
    npm ci --no-audit --no-fund; if ($LASTEXITCODE) { return }
    npm run build; if ($LASTEXITCODE) { return }
    Write-Host "Built. Starting Claudia Local (Ctrl+C stops it; run '$Dir\start.cmd' to start it again)."
    node bin\claudia-local.js
  } finally { Pop-Location }
}
Install-ClaudiaLocal
