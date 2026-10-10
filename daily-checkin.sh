#!/bin/bash
# 每日签到入口（由 install-daily.sh 安装的 launchd 任务调用）
#
# 相比直接跑 checkin.mjs，这里多做两件必要的事：
#   1) 等网络就绪 —— Mac 睡眠错过时间后，launchd 会在唤醒瞬间补跑，
#      那时网络往往还没起来，整批会以 "HTTP 0 fetch failed" 失败
#   2) 先修复过期登录态 —— WorkBuddy 的业务会话 session/session_2 只有 7 天有效期，
#      但 Keycloak SSO Cookie 有 1 年；用无头浏览器访问一次站点即可静默续上。
#      不做这步，账号每隔约 7 天就会集体变成「登录已过期」。
#
# 正常账号会自动跳过（只发一次 HTTP 探测，不开浏览器），所以日常开销很小。
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

STAMP() { date '+%F %T'; }

# ── 解析 node 路径（必须能扛住 node 版本升级）──
#    坑：launchd plist 里写死了 NODE_BIN=/…/versions/22.22.2-3/bin/node，
#    但 managed node 升级成 22.22.2-6 后旧目录被删 → 脚本拿着无效路径一路跑到底，
#    表现是「定时任务静默失效」。所以这里逐级兜底。
NODE_BIN="${NODE_BIN:-}"
if [ ! -x "$NODE_BIN" ]; then
  [ -n "$NODE_BIN" ] && echo "[$(STAMP)] ⚠️ 配置的 node 不存在：$NODE_BIN，自动回退"
  # 兜底 1：managed node 里版本号最大的那个
  NODE_BIN="$(ls -d /Users/apple/.workbuddy-ai/binaries/node/versions/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ ! -x "$NODE_BIN" ]; then
  # 兜底 2：PATH 里的 node（launchd 环境里 PATH 很干净，常常找不到，但值得一试）
  NODE_BIN="$(command -v node 2>/dev/null || true)"
fi
if [ ! -x "$NODE_BIN" ]; then
  # 兜底 3：homebrew / 系统常见位置
  for c in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { NODE_BIN="$c"; break; }
  done
fi
if [ ! -x "$NODE_BIN" ]; then
  echo "[$(STAMP)] ❌ 找不到可用的 node，任务中止。请检查 node 安装。"
  exit 1
fi
echo "[$(STAMP)] node: $NODE_BIN（$("$NODE_BIN" -v 2>/dev/null)）"

# ── 1) 等网络就绪（最多等 2 分钟）──
NET_OK=0
for i in $(seq 1 12); do
  if curl -s -o /dev/null --max-time 5 https://www.workbuddy.cn/; then NET_OK=1; break; fi
  echo "[$(STAMP)] ⏳ 网络还没就绪，等待中…（第 $i 次）"
  sleep 10
done
if [ "$NET_OK" != "1" ]; then
  echo "[$(STAMP)] ⚠️ 等待 2 分钟后网络仍不通，仍然尝试执行（失败会在日志里体现）"
fi

# ── 2) 检查登录态并按需续期 ──
#    WorkBuddy 业务会话只有 7 天有效期，--max-age 5 表示「距上次续期超过 5 天就主动续」，
#    这样不会等到失效才发现。健康的账号仍只发一次 HTTP 探测，不会白开浏览器。
echo "[$(STAMP)] 🔧 检查登录态…"
"$NODE_BIN" tools/repair-state.mjs --max-age 5 2>&1 | sed 's/^/    /'

# ── 3) 成长中心：报名任务 + 领已达标奖励 + Buddy 旅行 ──
#    只做正当部分：报名（让进度开始计）+ 领「进度已达标」的奖 + Buddy 旅行。
#    不伪造任何行为事件刷进度。用 config.json 的 growth.enabled 关掉。
if [ "${GROWTH_ENABLED:-1}" = "1" ]; then
  echo "[$(STAMP)] 🐱 成长中心…"
  "$NODE_BIN" growth.mjs run 2>&1 | sed 's/^/    /'
fi

# ── 4) 执行签到 ──
echo "[$(STAMP)] 📅 开始签到"
exec "$NODE_BIN" checkin.mjs checkin --notify
