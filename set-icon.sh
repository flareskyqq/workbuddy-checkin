#!/bin/bash
# 换看板图标：./set-icon.sh orange | navy | cream
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ID="${1:-orange}"
PNG="$DIR/build/cat/cat-$ID.png"
if [ ! -f "$PNG" ]; then
  echo "用法：./set-icon.sh orange | navy | cream"; exit 1
fi
mkdir -p "$DIR/build/icon.iconset"
for s in 16 32 64 128 256 512 1024; do
  sips -z "$s" "$s" "$PNG" --out "$DIR/build/icon.iconset/icon_${s}x${s}.png" >/dev/null
done
cp "$DIR/build/icon.iconset/icon_32x32.png"  "$DIR/build/icon.iconset/icon_16x16@2x.png"
cp "$DIR/build/icon.iconset/icon_64x64.png"  "$DIR/build/icon.iconset/icon_32x32@2x.png"
cp "$DIR/build/icon.iconset/icon_256x256.png" "$DIR/build/icon.iconset/icon_128x128@2x.png"
cp "$DIR/build/icon.iconset/icon_512x512.png" "$DIR/build/icon.iconset/icon_256x256@2x.png"
cp "$DIR/build/icon.iconset/icon_1024x1024.png" "$DIR/build/icon.iconset/icon_512x512@2x.png"
iconutil -c icns "$DIR/build/icon.iconset" -o "$DIR/build/AppIcon.icns"
for APP in "$DIR/build/WorkBuddy积分.app" "$HOME/Applications/WorkBuddy积分.app"; do
  [ -d "$APP" ] || continue
  cp "$DIR/build/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
  touch "$APP"
done
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREG" ] && "$LSREG" -f "$HOME/Applications/WorkBuddy积分.app" >/dev/null 2>&1 || true
node "$DIR/build/cat/update-favicon.mjs" "$ID"
launchctl kickstart -k "gui/$(id -u)/com.workbuddy.dashboard" >/dev/null 2>&1 || true
echo "✅ 图标已换成【$ID】猫（App + 网页都更新了）"
