#!/bin/bash
# 安装每天自动签到（macOS launchd 定时任务）
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.workbuddy.daily-checkin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
HOUR_PRIMARY="${HOUR_PRIMARY:-9}"
MIN_PRIMARY="${MIN_PRIMARY:-5}"
HOUR_RETRY="${HOUR_RETRY:-14}"
MIN_RETRY="${MIN_RETRY:-30}"

mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/daily-checkin.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_BIN</key>
    <string>$NODE_BIN</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>$DIR</string>
  <key>StartCalendarInterval</key>
  <array>
    <dict>
      <key>Hour</key><integer>$HOUR_PRIMARY</integer>
      <key>Minute</key><integer>$MIN_PRIMARY</integer>
    </dict>
    <dict>
      <key>Hour</key><integer>$HOUR_RETRY</integer>
      <key>Minute</key><integer>$MIN_RETRY</integer>
    </dict>
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$DIR/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$DIR/logs/launchd.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST"
launchctl enable "gui/$UID/$LABEL" 2>/dev/null || true

echo "✅ 已安装每日自动签到"
echo "   时间：每天 ${HOUR_PRIMARY}:$(printf '%02d' "$MIN_PRIMARY")，并在 ${HOUR_RETRY}:$(printf '%02d' "$MIN_RETRY") 补一次（当天已签到会自动跳过）"
echo "   配置：$PLIST"
echo "   日志：$DIR/logs/"
echo "   立即手动跑一次：node \"$DIR/checkin.mjs\" checkin"
