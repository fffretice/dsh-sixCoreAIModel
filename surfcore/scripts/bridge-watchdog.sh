#!/bin/bash
# 桥接看门狗：DSH 重启后端口会变，桥接拿着旧端口会静默失联。
# 这里每 3 分钟核一次「桥接连的 DSH 端口 == 当前 DSH 实际端口」，不一致就用新端口重启桥接。
# 适合放进 crontab：
#   */3 * * * * /path/to/surfcore/scripts/bridge-watchdog.sh
set -u
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$BASE/state/bridge-watchdog.log"
mkdir -p "$BASE/state"
TOK=$(cat "$BASE/state/console-token" 2>/dev/null || true)

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

PORT=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '/DeepSeek|dsh/ && /127\.0\.0\.1/ {print $9}' | sed 's/.*://' | head -1)
if [ -z "$PORT" ]; then echo "$(date '+%m-%d %H:%M:%S') DSH 没在监听，跳过" >> "$LOG"; exit 0; fi

CUR=$(curl -s -m 5 -H "x-console-token: $TOK" http://127.0.0.1:3100/api/status 2>/dev/null \
  | "$PY" -c 'import sys,json;d=json.load(sys.stdin);print(d.get("dshBaseUrl",""),d.get("dshReady"))' 2>/dev/null || true)

if echo "$CUR" | grep -qi ":$PORT true"; then exit 0; fi

echo "$(date '+%m-%d %H:%M:%S') 需要重启：当前=[$CUR] DSH=$PORT" >> "$LOG"
pkill -f "src/bridge.js" 2>/dev/null
sleep 2
cd "$BASE" || exit 0
DSH_WEB_URL="http://127.0.0.1:$PORT" nohup node src/bridge.js >> "$BASE/state/bridge-watchdog.out" 2>&1 &
sleep 6
NEW=$(curl -s -m 5 -H "x-console-token: $TOK" http://127.0.0.1:3100/api/status 2>/dev/null \
  | "$PY" -c 'import sys,json;d=json.load(sys.stdin);print(d.get("dshBaseUrl",""),d.get("dshReady"))' 2>/dev/null || true)
echo "$(date '+%m-%d %H:%M:%S') 重启后=[$NEW]" >> "$LOG"
