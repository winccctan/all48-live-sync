#!/usr/bin/env bash
# 在本机后台常驻 live-sse-sync.mjs（直播中实时抓弦月回响）。
#
#   ./deploy/start-sse.sh            # 起一个实例（单 IP 上限 ~6 路）
#   ./deploy/start-sse.sh --stop     # 停
#   ./deploy/start-sse.sh --status   # 看状态
#
# 🔴 单出口 IP 最多 ~6 条并发弹幕流（第 7 条 start 直接 429）。
#    想覆盖更多直播间只能多机/多出口，用 SHARDS/SHARD 分片，见 .github/workflows/live-sse.yml。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="/tmp/all48-live-sse.pid"
LOG_FILE="/tmp/all48-live-sse.log"
NODE="${NODE:-/Users/tansy/.workbuddy/binaries/node/versions/22.22.2-6/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"

case "${1:-start}" in
  --stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")" && echo "已停（pid $(cat "$PID_FILE")）" || true
      rm -f "$PID_FILE"
    else
      pkill -f live-sse-sync.mjs 2>/dev/null && echo "已停（按进程名）" || echo "没在跑"
    fi
    exit 0
    ;;
  --status)
    echo "--- healthz ---"
    curl -s --noproxy '*' http://127.0.0.1:${HEALTHZ_PORT:-8790}/healthz || echo "（没响应，进程可能没起）"
    echo
    echo "--- 最后 15 行日志 ---"
    tail -15 "$LOG_FILE" 2>/dev/null || echo "（没有日志）"
    exit 0
    ;;
esac

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "已经在跑（pid $(cat "$PID_FILE")），先 --stop"
  exit 1
fi

if [ -f nim-sync.env ]; then
  set -a; . ./nim-sync.env; set +a
fi
: "${SITE_URL:?缺 SITE_URL（写在 nim-sync.env 里）}"
: "${INGEST_TOKEN:?缺 INGEST_TOKEN（写在 nim-sync.env 里）}"

# 🔴 必须绕开沙箱/系统代理：48fan 是直连可用的，走代理反而可能被限流或握手失败。
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  "$NODE" live-sse-sync.mjs >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
sleep 3
echo "已启动 pid $(cat "$PID_FILE")，日志 $LOG_FILE"
echo "状态：curl -s http://127.0.0.1:${HEALTHZ_PORT:-8790}/healthz"
