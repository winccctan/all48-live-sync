#!/usr/bin/env bash
# 红蓝歌会 · 直播礼物实时监听 —— 本机启动（无国内服务器时用）
#
# 用法：
#   ./deploy/start-local.sh          前台跑，Ctrl-C 停
#   ./deploy/start-local.sh --bg     后台跑，日志写 nim-sync.log
#   ./deploy/start-local.sh --stop   停掉后台那个
#   ./deploy/start-local.sh --awake  前台跑并阻止系统睡眠（Mac 合盖仍会睡）
#
# 前置：本目录下有 nim-sync.env（从 nim-sync.env.example 复制后填三项）
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/.." && pwd)
cd "$APP"

ENV_FILE=${ENV_FILE:-$APP/nim-sync.env}
LOG=${NIM_LOG:-$APP/nim-sync.log}
PIDFILE=$APP/nim-sync.pid

# 选 Node：NODE_BIN（env 里写死的绝对路径）> PATH > 常见安装位置 > 绿色解压目录
# 之所以要这么宽：launchd 拉起的进程几乎没有 PATH，必须能靠绝对路径找到 node
pick_node() {
  local c
  for c in "${NODE_BIN:-}" \
           "$(command -v node 2>/dev/null || true)" \
           /usr/local/bin/node \
           /opt/homebrew/bin/node \
           "$HOME/.local/bin/node" \
           "$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin/node"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  # 绿色解压版：~/.local/node-vXX.X.X-darwin-arm64/bin/node（有多个取最后一个）
  local last=""
  for c in "$HOME"/.local/node-v*/bin/node; do [ -x "$c" ] && last="$c"; done
  [ -n "$last" ] && { echo "$last"; return; }
  return 1
}

[ -f "$ENV_FILE" ] || { echo "✗ 缺少 $ENV_FILE（cp nim-sync.env.example nim-sync.env 后填三项）" >&2; exit 1; }

NODE=$(pick_node) || { echo "✗ 找不到 node（需要 18+）" >&2; exit 1; }

case "${1:-}" in
  --stop)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      kill "$(cat "$PIDFILE")" && echo "已停止（pid $(cat "$PIDFILE")）"
      rm -f "$PIDFILE"
    else
      pkill -f "node .*live-nim-sync.mjs" 2>/dev/null && echo "已停止（按进程名）" || echo "没有在跑"
      rm -f "$PIDFILE"
    fi
    exit 0
    ;;
  --bg)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "已经在跑（pid $(cat "$PIDFILE")），先 --stop"
      exit 1
    fi
    echo "启动中…日志 $LOG"
    nohup env ENV_FILE="$ENV_FILE" bash "$0" >>"$LOG" 2>&1 &
    echo $! > "$PIDFILE"
    sleep 8
    echo "--- 最近日志"
    tail -n 20 "$LOG" || true
    echo "--- healthz"
    curl -s --max-time 5 "http://127.0.0.1:${NIM_PORT:-8788}/healthz" | head -20 || echo "（还没起来）"
    exit 0
    ;;
  --awake)
    set -a; . "$ENV_FILE"; set +a
    echo "（已开启防睡眠；Ctrl-C 停）"
    exec caffeinate -is "$NODE" live-nim-sync.mjs
    ;;
esac

set -a
. "$ENV_FILE"
set +a
echo "node: $NODE"
exec "$NODE" live-nim-sync.mjs
