#!/bin/bash
# 给管理员推一条 QQ 私聊（文字 / 图片）。用法：
#   notify-owner.sh "文字内容"
#   notify-owner.sh "文字内容" /path/to/image.png
# 依赖：config.json 里已配好 snowluma.accessToken 与 ownerQQ；本机 3000 端口是 OneBot HTTP。
set -euo pipefail
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MSG="${1:?用法: notify-owner.sh \"文字\" [图片路径]}"
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
