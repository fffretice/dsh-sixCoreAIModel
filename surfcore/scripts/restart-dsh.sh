#!/bin/bash
# 重启 DSH 并把她接回去。
# 为什么要有这个脚本：DSH 每次重启端口都会变，桥接拿着旧端口会静默失联；
# 而重启本身会杀掉发起它的会话，所以必须 detach 出去跑：
#   nohup ./scripts/restart-dsh.sh 20 >/dev/null 2>&1 &
set -u
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$BASE/state/restart-dsh.log"
mkdir -p "$BASE/state"
TOK=$(cat "$BASE/state/console-token" 2>/dev/null || true)
say() { echo "$(date '+%m-%d %H:%M:%S') $*" >> "$LOG"; }

sleep "${1:-20}"
say "开始重启 DSH"
osascript -e 'quit app "DeepSeek Harness"' 2>/dev/null
for i in $(seq 1 30); do
  pgrep -f "MacOS/DeepSeek" >/dev/null 2>&1 || break
  sleep 1
done
say "DSH 已退出"
sleep 2
open -a "DeepSeek Harness"
say "已重新打开，等端口"

PORT=""
for i in $(seq 1 60); do
  PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek/ && /127\.0\.0\.1/ {print $9}' | sed 's/.*://' | head -1)
  [ -n "$PORT" ] && break
  sleep 2
done
if [ -z "$PORT" ]; then say "60 秒内没等到 DSH 端口，放弃（看门狗会继续试）"; exit 0; fi
say "DSH 端口：$PORT"

pkill -f "src/bridge.js" 2>/dev/null
sleep 2
cd "$BASE" || exit 0
DSH_WEB_URL="http://127.0.0.1:$PORT" nohup node src/bridge.js >> /tmp/bridge-restart.out 2>&1 &
disown
sleep 10

ST=$(curl -s -m 5 -H "x-console-token: $TOK" http://127.0.0.1:3100/api/status 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("mode"),d.get("dshReady"),d.get("role"))' 2>/dev/null || true)
say "桥接状态：[$ST]"
say "完成"
