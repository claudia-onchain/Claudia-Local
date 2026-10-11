#!/bin/bash
# start.sh: install and build if needed, then start Claudia Local on 127.0.0.1 and open it in your browser.
# Windows: use start.cmd (or start.ps1). Data lives in ~/.claudia-local, not in this folder.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "Claudia Local needs Node.js 22.13 or newer: https://nodejs.org (LTS)" >&2
  exit 1
fi
[ -d node_modules ] || npm ci --no-audit --no-fund
[ -f dashboard/dist/index.html ] || npm run build

exec node bin/claudia-local.js "$@"
