#!/usr/bin/env python3
"""非智能看门狗（launchd 每 10 分钟跑一次）：
1. DSH 进程不在 → 自动拉起并通知；
2. 每小时自检太久没跑（>75 分钟）→ 发 QQ 告警。
不看模型、不要 token，纯进程与文件。
"""
import json, os, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.environ.get("WATCHDOG_STATE", os.path.join(ROOT, "state"))
DSH_BIN = os.environ.get("WATCHDOG_DSH_BIN", "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness")
DSH_APP = "/Applications/DeepSeek Harness.app"
REVIVE = os.path.join(STATE, "dsh-revive.json")
SELFCHECK_LAST = os.path.join(STATE, "selfcheck-last.json")
ALERT = os.path.join(STATE, "selfcheck-watchdog.json")
NOTIFY = os.path.join(ROOT, "scripts", "notify-owner.sh")

THRESHOLD_MIN = int(os.environ.get("WATCHDOG_GAP_MIN", "75"))
REVIVE_COOLDOWN = 300      # 5 分钟
ALERT_COOLDOWN = 2 * 3600  # 2 小时


def read_json(path, fallback):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return fallback


def write_json(path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
    except Exception:
        pass


def notify(text):
    try:
        subprocess.run([NOTIFY, text], capture_output=True, timeout=30)
    except Exception:
        pass


def dsh_pids():
    """按「可执行文件路径」精确匹配，而不是按命令行子串。

    踩过的坑：用 `ps ... command=` 做子串匹配时，**跑检查的自己**（bash -c / python3 的参数）
    也会命中，导致「DSH 明明没开却报在跑」。comm 是内核给的可执行路径，不会被自称误导。
    """
    try:
        out = subprocess.run(["ps", "-Ao", "pid=,comm="], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    pids = []
    for line in out.splitlines():
        parts = line.strip().split(" ", 1)
        if len(parts) != 2:
            continue
        pid, comm = parts
        if comm.strip() == DSH_BIN and pid.isdigit():
            pids.append(pid)
    return pids


def main():
    now = int(time.time())
    pids = dsh_pids()
    if not pids:
        last = int(read_json(REVIVE, {}).get("atEpoch", 0) or 0)
        if now - last < REVIVE_COOLDOWN:
            print("DSH 不在，但 5 分钟内试过拉起，跳过")
            return
        print("DSH 不在 → 尝试拉起")
        write_json(REVIVE, {"atEpoch": now, "at": time.strftime("%Y-%m-%d %H:%M:%S")})
        try:
            subprocess.run(["open", "-a", DSH_APP], capture_output=True, timeout=20)
        except Exception as e:
            print("open 失败:", e)
        time.sleep(25)
        pids = dsh_pids()
        if pids:
            notify(f"【助手】发现 DSH 不在了，已经自动拉起来（pid {pids[0]}）。桥接大概 1 分钟内会自己重连，接不上我再处理。")
            print(f"已拉起 DSH（pid {pids[0]}）")
        else:
            notify("【助手】DSH 挂了，我尝试拉起但没起来。你看看是不是弹了权限提示或者卡在更新。")
            print("拉起失败，已告警")
        return

    print(f"DSH 在跑（pid {pids[0]}）")

    # 自检开关关掉时，不再按「太久没跑」告警（2026-11-06 老大停用每小时自检）
    try:
        ctl = read_json(os.path.expanduser("~/.dsh/selfcheck.json"), {})
        if ctl.get("enabled", True) is False:
            print("自检已关闭，跳过间隔检查")
            return
    except Exception:
        pass

    # 自检是否太久没跑
    last_at = int(read_json(SELFCHECK_LAST, {}).get("atEpoch", 0) or 0)
    if last_at <= 0:
        print("还没有自检记录")
        return
    gap_min = (now - last_at) // 60
    print(f"距上次自检 {gap_min} 分钟（阈值 {THRESHOLD_MIN}）")
    if gap_min < THRESHOLD_MIN:
        return
    last_alert = int(read_json(ALERT, {}).get("atEpoch", 0) or 0)
    if now - last_alert < ALERT_COOLDOWN:
        print("刚告警过，节流中")
        return
    notify(f"【助手】自检停了：已经 {gap_min} 分钟没跑（正常每小时一次）。\n可能原因：提醒丢了 / 电脑睡了。DSH 进程本身是活的。")
    write_json(ALERT, {"atEpoch": now, "gapMinutes": gap_min})
    print("已发告警")


if __name__ == "__main__":
    main()
