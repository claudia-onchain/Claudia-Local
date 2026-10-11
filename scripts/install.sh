#!/bin/sh
# Install Claudia Local (macOS, Linux, WSL).   curl -fsSL https://useclaudia.xyz/install.sh | sh
#
# What this does, in order:
#   1. checks that Node.js 22.13 or newer is installed (it never installs Node for you);
#   2. runs `npm install -g claudia-local`; if that fails (no npm registry access, no rights for global
#      installs), it clones github.com/claudia-onchain/Claudia-Local into ~/claudia-local and builds it;
#   3. starts Claudia Local, which opens http://127.0.0.1:3939 in your browser.
# Your data lives in ~/.claudia-local. Nothing else on your computer is changed.
set -eu

REPO="https://github.com/claudia-onchain/Claudia-Local.git"
DIR="${CLAUDIA_LOCAL_SRC:-$HOME/claudia-local}"

need_node() {
  echo "Claudia Local needs Node.js 22.13 or newer." >&2
  echo "Get the LTS from https://nodejs.org, or with a version manager:  nvm install --lts" >&2
  echo "Then run this installer again." >&2
  exit 1
}
command -v node >/dev/null 2>&1 || need_node
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' || need_node
command -v npm >/dev/null 2>&1 || need_node
echo "Node $(node -v) found."

if npm install -g claudia-local --no-audit --no-fund; then
  echo "Installed. Starting Claudia Local (Ctrl+C stops it; run 'claudia-local' to start it again)."
  exec claudia-local
fi

echo "npm install -g didn't work; building from source in $DIR instead."
command -v git >/dev/null 2>&1 || { echo "That needs git: https://git-scm.com" >&2; exit 1; }
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"
npm ci --no-audit --no-fund
npm run build
echo "Built. Starting Claudia Local (Ctrl+C stops it; run '$DIR/start.sh' to start it again)."
exec node bin/claudia-local.js
