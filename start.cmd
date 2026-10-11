@echo off
rem start.cmd: install and build if needed, then start Claudia Local on 127.0.0.1 and open it in your browser.
rem Same as start.sh, for Windows. Data lives in %USERPROFILE%\.claudia-local, not in this folder.
setlocal
cd /d "%~dp0"

where node >nul 2>nul || goto :nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || goto :nonode

if not exist node_modules (
  call npm ci --no-audit --no-fund || exit /b 1
)
if not exist dashboard\dist\index.html (
  call npm run build || exit /b 1
)
node bin\claudia-local.js %*
exit /b %errorlevel%

:nonode
echo Claudia Local needs Node.js 22.13 or newer: https://nodejs.org (LTS)
exit /b 1
