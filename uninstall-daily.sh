#!/bin/bash
# 卸载每天自动签到
set -euo pipefail
LABEL="com.workbuddy.daily-checkin"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
[ -f "$PLIST" ] && mv "$PLIST" "$PLIST.disabled"
echo "✅ 已卸载（配置改名为 $PLIST.disabled，需要时改回来即可）"
