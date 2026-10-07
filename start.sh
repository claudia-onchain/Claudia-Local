#!/bin/bash
# start.sh: build if needed, start Claudia Local on 127.0.0.1, open it in your browser.
set -e
cd "$(dirname "$0")"
PORT="${CLAUDIA_LOCAL_PORT:-3939}"
URL="http://127.0.0.1:${PORT}"

if ! command -v node >/dev/null 2>&1; then
  echo "Claudia Local needs Node.js 20 or newer: https://nodejs.org" >&2
  exit 1
fi
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f dashboard/dist/index.html ] || npm run build

if curl -fs "${URL}/api/health" >/dev/null 2>&1; then
  echo "Claudia Local is already running: ${URL}"
else
  CLAUDIA_LOCAL_PORT="$PORT" node server/index.js &
  SERVER_PID=$!
  trap 'kill $SERVER_PID 2>/dev/null; exit 0' INT TERM
  for _ in $(seq 1 40); do curl -fs "${URL}/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
fi

echo ""
echo "  Claudia Local: ${URL}"
echo "  Press Ctrl+C to stop."
echo ""
if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1; fi
[ -n "${SERVER_PID:-}" ] && wait "$SERVER_PID"
