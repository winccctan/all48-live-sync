#!/usr/bin/env bash
# 微信群桥 · 常驻守护（桥崩了/被回收了，5 秒后自动拉起）
#
# 用法（在自己的终端窗口里跑，这个窗口别关）：
#   bash wxbot/daemon.sh
#
# 想彻底脱手（关终端也不停）：
#   nohup bash wxbot/daemon.sh > /tmp/wxbot-daemon.log 2>&1 &
#   disown
#
# 🔴 为什么需要它：bridge 本身只会重连「微信事件流」，但进程被外部杀掉、
#    或 daemon 卡死时它自己救不回来。这台机器的 launchd / crontab 都被系统权限挡着
#    （launchctl bootstrap 报 Input/output error，crontab 报 operation not permitted），
#    所以只能靠这一层 while 循环兜底。
set -uo pipefail
cd "$(dirname "$0")/.."

# 单实例：有旧的先清掉，避免两个桥抢同一个账号
pkill -f 'agent-wechat-bridg[e].mjs' 2>/dev/null
sleep 1

while true; do
  echo "[daemon $(date '+%F %T')] 启动桥"
  bash wxbot/run.sh
  code=$?
  echo "[daemon $(date '+%F %T')] 桥退出（code=$code），5 秒后重来"
  sleep 5
done
