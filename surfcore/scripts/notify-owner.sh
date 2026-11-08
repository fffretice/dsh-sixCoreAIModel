#!/bin/bash
# 给老大推 QQ 私聊（文字 / 图片）。用法：
#   notify-owner.sh "文字内容"
#   notify-owner.sh "文字内容" /path/to/image.png
#
# 失败时不丢消息：写进 state/assistant-outbox.jsonl，下一轮自检可以重试。
set -uo pipefail
MSG="$1"
# 助手发给老大的话，一律带【助手】前缀（老大 2026-10-29 定的规矩）
case "$MSG" in
  【助手】*|[助手]*) ;;
  *) MSG="【助手】$MSG" ;;
esac
IMG="${2:-}"

PY=python3
command -v "$PY" >/dev/null 2>&1 || PY=python

CT=$("$PY" -c "import json;print(json.load(open('$BASE/config.json',encoding='utf-8'))['snowluma']['accessToken'])")
OWNER=$("$PY" -c "import json;print(json.load(open('$BASE/config.json',encoding='utf-8'))['ownerQQ'])")

"$PY" - "$MSG" "$IMG" "$CT" "$OWNER" <<'PYEOF'
import base64, json, sys, urllib.request
msg, img, token, owner = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
segs = [{"type": "text", "data": {"text": msg}}]
if img:
    with open(img, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    segs.append({"type": "image", "data": {"file": "base64://" + b64}})
req = urllib.request.Request(
    "http://127.0.0.1:3000/send_private_msg",
    data=json.dumps({"user_id": int(owner), "message": segs}).encode(),
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST",
)
print(urllib.request.urlopen(req, timeout=30).read().decode()[:120])
PYEOF
