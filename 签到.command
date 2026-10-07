#!/bin/bash
# 双击即可手动签到全部账号（WorkBuddy + TraeWork）
cd "$(dirname "$0")"
node checkin.mjs checkin
echo
echo "按回车关闭窗口…"
read _
