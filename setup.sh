#!/bin/bash
# 一键安装：依赖 + 定时任务 + 桌面 App
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

command -v node >/dev/null 2>&1 || { echo "❌ 请先安装 Node.js（建议 20 以上）"; exit 1; }
echo "① 安装依赖（playwright-core）…"
npm i playwright-core@1.63.0 --no-audit --no-fund >/dev/null
echo "   ✅ 完成"

echo "② 安装每日定时任务…"
./install-daily.sh

echo "③ 安装桌面 App…"
mkdir -p "$HOME/Applications"
[ -e "$HOME/Applications/WorkBuddy积分.app" ] && mv "$HOME/Applications/WorkBuddy积分.app" "$HOME/Applications/WorkBuddy积分.app.old-$(date +%H%M%S)"
cp -R "build/WorkBuddy积分.app" "$HOME/Applications/" 2>/dev/null || echo "   ⚠️ 未找到 App 包，跳过"
xattr -cr "$HOME/Applications/WorkBuddy积分.app" 2>/dev/null || true

echo
echo "✅ 安装完成！"
echo "   下一步："
echo "     1) 登录账号：node checkin.mjs add 账号名   （会弹 Edge，扫码登录）"
echo "     2) 打开看板：node dashboard.mjs  或双击 ~/Applications/WorkBuddy积分.app"
