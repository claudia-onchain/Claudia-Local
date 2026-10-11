#!/bin/bash
# build-app.sh: wraps Claudia Local in a macOS app ("Claudia Local.app"). No signing keys needed:
# the bundle is unsigned, so the first time macOS asks you to confirm it (right-click → Open).
#
#   npm run app:mac                     → ~/Applications/Claudia Local.app
#   OUT=/some/dir npm run app:mac       → /some/dir/Claudia Local.app
#
# The app uses the Node.js installed on this Mac (20 or newer) and keeps its data in ~/.claudia-local.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Claudia Local"
OUT_DIR="${OUT:-$HOME/Applications}"
APP="$OUT_DIR/$APP_NAME.app"
VERSION="$(node -p "require('$ROOT/package.json').version")"

cd "$ROOT"
[ -f dashboard/dist/index.html ] || npm run build

echo "Building $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

# App files: server, built dashboard, production dependencies.
cp -R server package.json package-lock.json LICENSE "$APP/Contents/Resources/app/"
mkdir -p "$APP/Contents/Resources/app/dashboard"
cp -R dashboard/dist "$APP/Contents/Resources/app/dashboard/dist"
(cd "$APP/Contents/Resources/app" && npm ci --omit=dev --no-audit --no-fund --silent)

# Icon from Claudia's face (sips + iconutil ship with macOS).
ICONSET="$(mktemp -d)/claudia.iconset"
mkdir -p "$ICONSET"
SRC="$ROOT/dashboard/public/claudia/icon-512.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); [ $d -le 512 ] && sips -z $d $d "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/claudia.icns" 2>/dev/null || cp "$SRC" "$APP/Contents/Resources/claudia.png"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>xyz.useclaudia.local</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>claudia.icns</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/launch" <<'LAUNCH'
#!/bin/bash
# Starts Claudia Local on 127.0.0.1 and opens it in the default browser.
APP_DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
PORT="${CLAUDIA_LOCAL_PORT:-3939}"
URL="http://127.0.0.1:$PORT"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$PATH"
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && PATH="$d:$PATH"; done
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Claudia Local needs Node.js 20 or newer. Install it from nodejs.org and open the app again." buttons {"OK"} default button 1 with title "Claudia Local"'
  exit 1
fi
if curl -fs "$URL/api/health" >/dev/null 2>&1; then open "$URL"; exit 0; fi
mkdir -p "$HOME/.claudia-local" && chmod 700 "$HOME/.claudia-local"
node "$APP_DIR/server/index.js" >>"$HOME/.claudia-local/app.log" 2>&1 &
PID=$!
for _ in $(seq 1 40); do curl -fs "$URL/api/health" >/dev/null 2>&1 && break; sleep 0.25; done
open "$URL"
trap 'kill $PID 2>/dev/null' TERM INT
wait $PID
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"

echo "Done: $APP"
echo "Open it from Finder (first time: right-click → Open, because the app isn't signed)."
