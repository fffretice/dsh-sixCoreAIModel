#!/usr/bin/env bash
# 自检开关（2026-10-29）
#   on      启用（selfcheck 正常干活）
#   off     关闭（自检醒来后直接结束，不做任何事、不发任何消息）
#   status  看当前状态
set -uo pipefail
CFG="$HOME/.dsh/selfcheck.json"
mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] || echo '{"enabled": true, "quietStart": 1, "quietEnd": 7}' > "$CFG"

case "${1:-status}" in
  on)
    /usr/bin/python3 - "$CFG" <<'PY'
import json,sys,time
p=sys.argv[1]; d=json.load(open(p))
d["enabled"]=True; d["updatedAt"]=time.strftime("%Y-%m-%d %H:%M:%S")
json.dump(d, open(p,"w"), ensure_ascii=False, indent=2)
print("自检：已开启")
PY
    ;;
  off)
    /usr/bin/python3 - "$CFG" <<'PY'
import json,sys,time
p=sys.argv[1]; d=json.load(open(p))
d["enabled"]=False; d["updatedAt"]=time.strftime("%Y-%m-%d %H:%M:%S")
json.dump(d, open(p,"w"), ensure_ascii=False, indent=2)
print("自检：已关闭（下次醒来会直接跳过）")
PY
    ;;
  status|*)
    /usr/bin/python3 - "$CFG" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
print("自检：", "开启" if d.get("enabled", True) else "关闭", "| 更新时间:", d.get("updatedAt","-"))
PY
    ;;
esac
