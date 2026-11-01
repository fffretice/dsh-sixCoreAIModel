#!/usr/bin/env bash
# 薄壳：逻辑在 watchdog.py（bash 拼中文和引号太容易崩）
cd "$(dirname "$0")/.." || exit 1
exec /usr/bin/python3 scripts/watchdog.py "$@"
