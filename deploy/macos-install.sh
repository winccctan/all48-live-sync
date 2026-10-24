#!/usr/bin/env bash
# macOS：把监听装成「开机自启 + 崩溃自动重拉」的用户级 LaunchAgent
#
#   ./deploy/macos-install.sh          安装并立刻启动
#   ./deploy/macos-install.sh --remove 卸载
#
# 🔴 说明：LaunchAgent 只能管「系统醒着」的时间。
#    这里用 caffeinate 包一层，服务在跑时**不让系统空闲睡眠**（-i）、接电源时也不睡（-s）。
#    但**笔记本合盖**仍然会睡（macOS 的硬件行为，普通程序挡不住）⇒
#    长期挂最好用台式机，或笔记本接着电源、不合盖、把「关闭显示器后防止自动睡眠」打开。
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/.." && pwd)
LABEL=com.all48.nim-sync
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$APP/nim-sync.log"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  exit 0
fi

[ -f "$APP/nim-sync.env" ] || { echo "✗ 先准备 $APP/nim-sync.env" >&2; exit 1; }
chmod +x "$APP/deploy/start-local.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-i</string>
    <string>-s</string>
    <string>/bin/bash</string>
    <string>$APP/deploy/start-local.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

# 先停掉手动起的那个，避免两个进程抢同一把 NIM 账号（会被互踢）
"$APP/deploy/start-local.sh" --stop >/dev/null 2>&1 || true

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
sleep 8

echo "== 状态"
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" | head -5 || true
echo
echo "== 最近日志"
tail -n 15 "$LOG" 2>/dev/null || echo "（还没有日志）"
echo
echo "== healthz"
curl -s --max-time 5 "http://127.0.0.1:8788/healthz" | head -12 || echo "（还没起来）"
echo
echo "卸载：$APP/deploy/macos-install.sh --remove"
