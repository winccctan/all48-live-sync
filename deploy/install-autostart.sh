#!/bin/bash
# 星光播报 · 开机自启安装（幂等，可反复执行）
# 用途：把 live-notify（开播/下播 + 微信取件口）和 room-push（口袋房间消息）注册成
#       launchd 常驻服务，登录即启动、崩了自动拉起。
#
# ⚠️ 必须在「终端」里直接跑（不要经 WorkBuddy），launchctl 需要访问用户 launchd 域。

set -u
LABELS=("cc.wyc0518.all48-live-notify" "cc.wyc0518.all48-room-push")
LA="$HOME/Library/LaunchAgents"
LOG="$HOME/Library/Logs/all48"
UID_N=$(id -u)
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$LA" "$LOG"
chmod 755 "$LA"

echo "== 1/4 停掉手动跑的进程（避免 8789 端口冲突） =="
pkill -f "live-notify.mjs" 2>/dev/null && echo "   已停 live-notify"
pkill -f "room-push.mjs"   2>/dev/null && echo "   已停 room-push"
sleep 1

echo "== 2/4 安装 plist =="
for L in "${LABELS[@]}"; do
  if [ -f "$SRC/$L.plist" ]; then
    cp "$SRC/$L.plist" "$LA/$L.plist"
    chmod 644 "$LA/$L.plist"
    echo "   $L.plist 已就位"
  else
    echo "   [错误] 找不到 $SRC/$L.plist" >&2
    exit 1
  fi
done

echo "== 3/4 注册到 launchd =="
for L in "${LABELS[@]}"; do
  launchctl bootout "gui/$UID_N/$L" 2>/dev/null
  if launchctl bootstrap "gui/$UID_N" "$LA/$L.plist" 2>/dev/null; then
    echo "   $L 启动成功"
  else
    echo "   [失败] $L —— 手动排查：launchctl print gui/$UID_N/$L" >&2
  fi
done

sleep 3

echo "== 4/4 核对 =="
for L in "${LABELS[@]}"; do
  pid=$(launchctl list 2>/dev/null | awk -v l="$L" '$3==l{print $1}')
  if [ -n "$pid" ] && [ "$pid" != "-" ]; then
    echo "   ✅ $L  运行中 (pid $pid)"
  else
    echo "   ❌ $L  没跑起来，看日志 $LOG/"
  fi
done

echo
echo "取件口自检："
if curl -s --noproxy '*' -m 3 "http://127.0.0.1:8789/ping" | grep -q '"ok":1'; then
  echo "   ✅ 8789 已响应（手机可以取件了）"
else
  echo "   ⚠️ 8789 没响应，等 10 秒再试；仍不行看 $LOG/live-notify.err"
fi

echo
echo "日志位置：$LOG/"
echo "关掉自启：launchctl bootout gui/$UID_N/cc.wyc0518.all48-live-notify; launchctl bootout gui/$UID_N/cc.wyc0518.all48-room-push"
