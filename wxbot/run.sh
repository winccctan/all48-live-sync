#!/usr/bin/env bash
# 微信群指令桥 · 启动脚本
# 用法：bash wxbot/run.sh [--dry|--ping]
# 🔴 停掉时用 pkill -f 'agent-wechat-bridg[e].mjs'，脚本会自己带走 wx messages watch 子进程。
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source wxbot/agent-wechat.env
set +a
mkdir -p "$(dirname "$WX_CURSOR_FILE")"
chmod 700 "$(dirname "$WX_CURSOR_FILE")" 2>/dev/null || true
exec node wxbot/agent-wechat-bridge.mjs "$@"
