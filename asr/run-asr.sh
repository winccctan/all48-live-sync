#!/bin/sh
# ASR 常驻服务（2026-11-14）：本地模型转写口袋语音。
# 单独一个进程，挂了自动重启；pid 锁防止重复起（历史事故：多实例互相抢端口）。
PIDF=/app/asr/run.pid
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then exit 0; fi
echo $$ > "$PIDF"
trap 'rm -f "$PIDF"' EXIT
mkdir -p /app/asr/logs
while true; do
  node /app/asr/asr-server.mjs >> /app/asr/logs/asr.log 2>&1
  sleep 3
done
