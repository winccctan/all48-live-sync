#!/usr/bin/env bash
# 微信群指令桥 · Linux 容器启动脚本
# 用法：bash wxbot/run.sh [--dry|--ping]
# 🔴 容器版：wx 已全局安装（PATH），桥用 WX_BIN=wx 直接调用。
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
source wxbot/agent-wechat.env
set +a
mkdir -p "$(dirname "$WX_CURSOR_FILE")"
chmod 700 "$(dirname "$WX_CURSOR_FILE")" 2>/dev/null || true
exec node wxbot/agent-wechat-bridge.mjs "$@"
