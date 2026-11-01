#!/bin/bash
# 延迟关闭 DSH（交给 launchd 跑，所以 DSH 退出不会把它一起带走）
sleep "${1:-20}"
osascript -e 'quit app "DeepSeek Harness"' 2>/dev/null
