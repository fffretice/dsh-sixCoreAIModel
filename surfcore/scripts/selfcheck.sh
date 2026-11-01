#!/usr/bin/env bash
# 薄壳：真正的逻辑在 selfcheck.py（bash 里拼 JSON 太容易踩引号/编码坑）
cd "$(dirname "$0")/.." || exit 1
exec /usr/bin/python3 scripts/selfcheck.py "$@"
