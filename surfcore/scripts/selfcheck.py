#!/usr/bin/env python3
"""助手定时自检：新指令 + 服务健康 + 距上次自检多久。
输出人读摘要，并把结构化结果写到 state/selfcheck-last.json。
"""
import json, os, subprocess, sys, time, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, "state")
INBOX = os.path.join(STATE, "assistant-inbox.jsonl")
CURSOR = os.path.join(STATE, "assistant-inbox-cursor.json")
OUT = os.path.join(STATE, "selfcheck-last.json")


def read_json(path, fallback):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def http_code(url, token=None, timeout=4, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("x-console-token", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except Exception as e:
        return 0, str(e)


def main():
    argv = sys.argv[1:]
    # 开关：~/.dsh/selfcheck.json 里 enabled=false 时，自检直接跳过（不检查、不发消息）
    ctl_path = os.path.expanduser("~/.dsh/selfcheck.json")
    ctl = read_json(ctl_path, {"enabled": True})
    if ctl.get("enabled", True) is False:
        print("DISABLED 自检已关闭（~/.dsh/selfcheck.json），本轮跳过")
        return

    token = ""
    try:
        token = open(os.path.join(STATE, "console-token"), encoding="utf-8").read().strip()
    except Exception:
        pass

    # 1) 新指令
    total = 0
    try:
        with open(INBOX, encoding="utf-8") as f:
            lines = [l for l in f.read().splitlines() if l.strip()]
        total = len(lines)
    except Exception:
        lines = []
    seen = int(read_json(CURSOR, {}).get("lines", 0) or 0)
    if "--init" in argv or "--ack" in argv:
        # 把已读水位推到当前末尾（初始化 / 处理完后确认）
        with open(CURSOR, "w", encoding="utf-8") as f:
            json.dump({"lines": total, "at": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False)
        seen = total
    new_rows = []
    for line in lines[seen:]:
        try:
            d = json.loads(line)
        except Exception:
            continue
        text = str(d.get("text", ""))
        # inbox 里的东西默认就是指令：桥接在写入时已经把【助手指令】前缀剥掉了，
        # 只有她主动留的「留言」才带 kind=note。以前按前缀过滤会漏掉真指令（踩过）。
        if d.get("kind") == "note":
            continue
        new_rows.append({"at": d.get("at", ""), "key": d.get("key", ""), "text": text[:300]})

    # 2) 服务
    code, body = http_code("http://127.0.0.1:3100/api/status", token)
    dsh_ready = False
    try:
        dsh_ready = bool(json.loads(body).get("dshReady"))
    except Exception:
        pass
    voxd = http_code("http://127.0.0.1:8765/v1/health")[0]
    gsv = http_code("http://127.0.0.1:9880/docs")[0]
    try:
        with open(os.path.join(ROOT, "config.json"), encoding="utf-8") as f:
            sl_token = (json.load(f).get("snowluma") or {}).get("accessToken", "")
    except Exception:
        sl_token = ""
    snow = 0
    try:
        req = urllib.request.Request("http://127.0.0.1:3000/get_login_info", data=b"{}", method="POST")
        req.add_header("Content-Type", "application/json")
        if sl_token:
            req.add_header("Authorization", f"Bearer {sl_token}")
        with urllib.request.urlopen(req, timeout=4) as r:
            ok = json.loads(r.read().decode("utf-8", "ignore")).get("status") == "ok"
            snow = 200 if ok else r.status
    except Exception:
        snow = 0
    pet_pid = ""
    pet_alive = False
    try:
        out = subprocess.run(["pgrep", "-f", "pet/app/data/profile"], capture_output=True, text=True, timeout=5).stdout
        pids = [x for x in out.split() if x.isdigit()]
        if pids:
            pet_pid = pids[0]
            pet_alive = True
    except Exception:
        pass

    # 3) 距上次
    now = int(time.time())
    prev = int(read_json(OUT, {}).get("atEpoch", 0) or 0)
    gap = int((now - prev) / 60) if prev else -1

    result = {
        "atEpoch": now,
        "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "inbox": {"total": total, "seen": seen, "new": len(new_rows)},
        "newInstructions": new_rows,
        "services": {
            "bridge": 3100 if code == 200 else code,
            "dshReady": dsh_ready,
            "voxd": voxd,
            "gsv": gsv,
            "snowluma": snow,
            "petPid": pet_pid,
            "petAlive": pet_alive,
        },
        "gapMinutes": gap,
    }
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    print(f"自检 {result['at']}")
    print(f"  新指令: {len(new_rows)} 条（inbox {total} 行，已读到 {seen}）")
    print(f"  服务: dshReady={dsh_ready} voxd={voxd} gsv={gsv} snowluma={snow} 桌宠={pet_alive}({pet_pid or '-'})")
    print(f"  距上次自检: {gap} 分钟")
    # 群额度动态分配（2026-11-01）：读 bridge 每小时写下的 caps
    try:
        q = json.load(open(os.path.expanduser("~/SurfCore/state/quota-rebalance.json"), encoding="utf-8"))
        if q.get("caps"):
            today = __import__("datetime").datetime.now().strftime("%Y-%m-%d")
            tag = "已重置" if q.get("day") == today else f"旧数据 {q.get('day')}"
            pairs = " · ".join(f"{k} {v}" for k, v in q["caps"].items())
            print(f"  群额度({tag}): {pairs}")
        else:
            print("  群额度: 尚未分配（等 bridge 首次重算）")
    except Exception:
        print("  群额度: 无分配文件")
    for r in new_rows:
        print(f"  ---- 未处理: [{r['at'][:16]}] {r['text'][:160]}")
    # 机器可读一行，方便我一眼看
    print("JSON=" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
