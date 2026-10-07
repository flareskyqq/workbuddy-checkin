#!/bin/bash
# 双击即可登录（或重新登录）某个账号
cd "$(dirname "$0")"
echo "已配置的账号："
node checkin.mjs list
read -p "请输入要登录的账号备注名后回车: " name
node checkin.mjs login "$name"
echo
echo "按回车关闭窗口…"
read _
