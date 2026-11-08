#!/bin/bash
# 桥接守护：launchd 跑这个脚本，脚本负责「DSH 端口发现 + 拉起桥接 + 崩了再拉」。
# 为什么不直接让 launchd 跑 bridge.js：桥接需要一个会变的 DSH 端口（每次重启都变），
# 而且要和插件的 autoStartBridge 共存——所以这里做成「有实例就守着，没实例才起」。
set -u
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$BASE/state/bridge-supervisor.log"
mkdir -p "$BASE/state"
TOK=$(cat "$BASE/state/console-token" 2>/dev/null || true)
say() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }

bridge_ok() {
  curl -s -m 3 -H "x-console-token: $TOK" http://127.0.0.1:3100/api/status 2>/dev/null | grep -q '"ok":true'
}

# 桥接活着还不够：DSH 每次重启都换端口，桥接可能还连着旧端口（dshReady=false），
# 表现为「QQ 有消息、她却不说话」。这里比对它连的端口和 DSH 现在监听的端口。
bridge_matches_dsh() {
  local port="${1:-}"
  [ -z "$port" ] && return 1
  curl -s -m 3 -H "x-console-token: $TOK" http://127.0.0.1:3100/api/status 2>/dev/null \
    | grep -q ":$port\"" || return 1
  curl -s -m 3 -H "x-console-token: $TOK" http://127.0.0.1:3100/api/status 2>/dev/null \
    | grep -qi '"dshReady":true'
}

dsh_port() {
  lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ && /127\.0\.0\.1/ {print $9}' | sed 's/.*://' | head -1
}

say "守护启动"
while true; do
  if bridge_ok; then
    CUR_PORT=$(dsh_port)
    # DSH 正在重启/暂时没监听的瞬间，端口会是空的——这时不能把桥接杀了。
    if [ -z "$CUR_PORT" ]; then sleep 20; continue; fi
    if bridge_matches_dsh "$CUR_PORT"; then sleep 20; continue; fi
    # 连续两次都对不上才动手，避免 DSH 一瞬间忙/慢就触发重启风暴。
    sleep 8
    CUR_PORT2=$(dsh_port)
    [ -z "$CUR_PORT2" ] && { sleep 20; continue; }
    if bridge_matches_dsh "$CUR_PORT2"; then sleep 20; continue; fi
    say "桥接活着但连的不是当前 DSH 端口（应为 $CUR_PORT2），重启它"
    pkill -f "src/bridge.js" 2>/dev/null
    sleep 3
    continue
  fi
  # 3100 已被占（插件刚起的实例）就先不当真，别去撞
  if lsof -nP -iTCP:3100 -sTCP:LISTEN >/dev/null 2>&1; then
    sleep 10
    continue
  fi
  PORT=$(dsh_port)
  if [ -z "$PORT" ]; then
    say "桥接不在，但 DSH 也没监听，等 10 秒再看"
    sleep 10
    continue
  fi
  say "拉起桥接（DSH 端口 $PORT）"
  cd "$BASE" || exit 1
  DSH_WEB_URL="http://127.0.0.1:$PORT" node src/bridge.js >> /tmp/bridge-supervisor.out 2>&1 &
  CHILD=$!
  wait $CHILD
  say "桥接退出（pid $CHILD，码 $?），10 秒后重试"
  sleep 10
done
