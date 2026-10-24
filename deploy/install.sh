#!/usr/bin/env bash
# 红蓝歌会 · 直播礼物实时监听（NIM）—— 国内常驻机一键安装
#
# 用法（在仓库 all48-live-sync 目录里跑）：
#   sudo SITE_URL=https://all48.wyc0518.cc \
#        INGEST_TOKEN=xxx POCKET48_TOKEN=yyy \
#        bash deploy/install.sh
#
# 已经在跑就再跑一遍 = 升级（会 npm i + 重启，不动 nim-sync.env）。
#
# 只支持 Debian/Ubuntu（systemd）。macOS 别用这个，见 deploy/README.md。
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/all48-live-sync}
STATE_DIR=${STATE_DIR:-/var/lib/all48-nim}
ENV_FILE="$APP_DIR/nim-sync.env"
NPM_REGISTRY=${NPM_REGISTRY:-https://registry.npmmirror.com}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "要用 root 跑：sudo bash deploy/install.sh"
[ -f live-nim-sync.mjs ] || die "请在 all48-live-sync 目录里运行（找不到 live-nim-sync.mjs）"

# ---------- 1. Node ----------
say "检查 Node"
NEED_INSTALL=1
if command -v node >/dev/null 2>&1; then
  V=$(node -v | sed 's/^v//')
  MAJOR=${V%%.*}
  echo "已装 node v$V"
  if [ "${MAJOR:-0}" -ge 18 ]; then NEED_INSTALL=0; fi
fi

if [ "$NEED_INSTALL" = "1" ]; then
  say "安装 Node 20（NodeSource）"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y -qq nodejs
  else
    die "不是 apt 系统，请自己装 node>=18 再跑"
  fi
fi
node -v || die "node 装不上"

# ---------- 2. 代码 ----------
say "部署代码到 $APP_DIR"
mkdir -p "$APP_DIR"
cp -f live-nim-sync.mjs package.json "$APP_DIR"/
rm -rf "$APP_DIR/lib"
cp -r lib "$APP_DIR"/
mkdir -p "$APP_DIR/deploy" "$STATE_DIR"
cp -f deploy/all48-nim-sync.service "$APP_DIR/deploy/" 2>/dev/null || true

say "安装依赖（registry=$NPM_REGISTRY）"
cd "$APP_DIR"
# 只装运行期依赖；--no-audit 免得国内网络卡在 audit 上
npm install --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" 2>&1 | tail -5

# ---------- 3. 环境变量 ----------
if [ -n "${SITE_URL:-}" ] || [ -n "${INGEST_TOKEN:-}" ] || [ -n "${POCKET48_TOKEN:-}" ] || [ ! -f "$ENV_FILE" ]; then
  say "写环境变量到 $ENV_FILE"
  if [ -f "$ENV_FILE" ]; then
    cp -f "$ENV_FILE" "$ENV_FILE.bak.$(date +%s)"
    # 保留旧值作为兜底：新参数没给就用旧的
    [ -z "${SITE_URL:-}" ] && SITE_URL=$(grep -E '^SITE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
    [ -z "${INGEST_TOKEN:-}" ] && INGEST_TOKEN=$(grep -E '^INGEST_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
    [ -z "${POCKET48_TOKEN:-}" ] && POCKET48_TOKEN=$(grep -E '^POCKET48_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)
  fi
  [ -n "${SITE_URL:-}" ] || die "缺少 SITE_URL"
  [ -n "${INGEST_TOKEN:-}" ] || die "缺少 INGEST_TOKEN"
  [ -n "${POCKET48_TOKEN:-}" ] || die "缺少 POCKET48_TOKEN"
  cat > "$ENV_FILE" <<EOF
SITE_URL=$SITE_URL
INGEST_TOKEN=$INGEST_TOKEN
POCKET48_TOKEN=$POCKET48_TOKEN
NIM_ROOMS_MAX=${NIM_ROOMS_MAX:-6}
NIM_PORT=${NIM_PORT:-8788}
NIM_BIND=${NIM_BIND:-127.0.0.1}
NIM_SCAN=60
NIM_FLUSH=5
EOF
  chmod 600 "$ENV_FILE"
else
  say "沿用已有 $ENV_FILE"
fi

# ---------- 4. 生成 systemd unit（路径按实际安装位置改） ----------
say "安装 systemd 服务"
sed -e "s#/opt/all48-live-sync#$APP_DIR#g" -e "s#/var/lib/all48-nim#$STATE_DIR#g" \
  deploy/all48-nim-sync.service > /etc/systemd/system/all48-nim-sync.service
systemctl daemon-reload
systemctl enable all48-nim-sync >/dev/null 2>&1 || true
systemctl restart all48-nim-sync
sleep 6

# ---------- 5. 自检 ----------
say "服务状态"
systemctl --no-pager status all48-nim-sync | head -20 || true
echo
say "最近日志"
journalctl -u all48-nim-sync -n 30 --no-pager || true
echo
say "健康检查"
if command -v curl >/dev/null 2>&1; then
  curl -s --max-time 5 "http://127.0.0.1:${NIM_PORT:-8788}/healthz" | head -40 || echo "（healthz 还没起来，看上面的日志）"
fi
echo
echo "常用命令："
echo "  journalctl -u all48-nim-sync -f            # 跟日志"
echo "  curl -s localhost:${NIM_PORT:-8788}/healthz # 看房间/收包/上报状态"
echo "  systemctl restart all48-nim-sync           # 重启"
echo "  vi $ENV_FILE && systemctl restart all48-nim-sync  # 改 token"
