#!/usr/bin/env bash
# 红蓝歌会 · 直播礼物监听 —— 在另一台 Mac 上「从零到跑起来」
#
# 用法（四项从环境变量传，脚本本身不含任何密钥）：
#   SITE_URL=https://all48-archive.yqz-tansy.workers.dev \
#   INGEST_TOKEN=xxx POCKET48_TOKEN=yyy SCRAPE_PROXY=zzz \
#   bash deploy/macos-bootstrap.sh [--launchd]
#
# --launchd  装成开机自启（LaunchAgent），默认只是后台起一下
#
# 做的事：
#   ① Node 没有就下官方 tar.gz 解压到 ~/.local（不装 homebrew、不要 sudo）
#   ② 拉代码（已经在就跑 git pull）
#   ③ 写 nim-sync.env（600，进 .gitignore）
#   ④ npm i（走 npmmirror）
#   ⑤ 起服务 / 装 LaunchAgent
set -euo pipefail

APP=${APP:-$HOME/all48-live-sync}
REPO=${REPO:-https://github.com/winccctan/all48-live-sync.git}
NODE_VERSION=${NODE_VERSION:-v22.11.0}

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = "Darwin" ] || die "这是给 macOS 用的；Linux 请直接用 deploy/install.sh"
for k in SITE_URL INGEST_TOKEN POCKET48_TOKEN SCRAPE_PROXY; do
  [ -n "${!k:-}" ] || die "缺少环境变量 $k"
done

# ---------- ① Node ----------
say "检查 Node（需要 18+）"
NODE_BIN=""
if have node; then
  V=$(node -v | sed 's/^v//'); MAJOR=${V%%.*}
  if [ "${MAJOR:-0}" -ge 18 ]; then NODE_BIN=$(command -v node); echo "已装 node v$V → $NODE_BIN"; fi
fi
if [ -z "$NODE_BIN" ]; then
  case "$(uname -m)" in
    arm64) ARCH=darwin-arm64 ;;
    x86_64) ARCH=darwin-x64 ;;
    *) die "未知架构 $(uname -m)" ;;
  esac
  TARBALL="node-$NODE_VERSION-$ARCH.tar.gz"
  URL="https://nodejs.org/dist/$NODE_VERSION/$TARBALL"
  mkdir -p "$HOME/.local"
  if [ ! -x "$HOME/.local/node-$NODE_VERSION-$ARCH/bin/node" ]; then
    echo "下载 $URL"
    # 官方源在国外可能慢，失败时退到 npmmirror 的镜像
    curl -fL --max-time 300 -o "/tmp/$TARBALL" "$URL" \
      || curl -fL --max-time 300 -o "/tmp/$TARBALL" "https://npmmirror.com/mirrors/node/$NODE_VERSION/$TARBALL" \
      || die "Node 下载失败（可以手动装一个 node 18+ 再回来跑）"
    tar -xzf "/tmp/$TARBALL" -C "$HOME/.local"
  fi
  NODE_BIN="$HOME/.local/node-$NODE_VERSION-$ARCH/bin/node"
  [ -x "$NODE_BIN" ] || die "Node 解压后找不到可执行文件"
  echo "绿色版 node → $NODE_BIN"
fi
NODE_DIR=$(dirname "$NODE_BIN")
NPM="$NODE_DIR/npm"
[ -x "$NPM" ] || NPM="$(command -v npm 2>/dev/null || true)"
[ -n "$NPM" ] && [ -x "$NPM" ] || die "找不到 npm（Node 装得不全）"

# ---------- ② 代码 ----------
say "拉代码到 $APP"
if [ -d "$APP/.git" ]; then
  (cd "$APP" && git pull -q --ff-only) || echo "（git pull 失败，继续用现有代码）"
else
  mkdir -p "$(dirname "$APP")"
  git clone -q --depth 1 "$REPO" "$APP"
fi
cd "$APP"

# ---------- ③ 环境变量 ----------
say "写 $APP/nim-sync.env"
if [ -f nim-sync.env ]; then cp -f nim-sync.env "nim-sync.env.bak.$(date +%s)"; fi
umask 077
cat > nim-sync.env <<ENV
SITE_URL=$SITE_URL
INGEST_TOKEN=$INGEST_TOKEN
POCKET48_TOKEN=$POCKET48_TOKEN
USE_PROXY=1
SCRAPE_PROXY=$SCRAPE_PROXY
NIM_ROOMS_MAX=${NIM_ROOMS_MAX:-6}
NIM_PORT=${NIM_PORT:-8788}
NIM_BIND=127.0.0.1
NODE_BIN=$NODE_BIN
ENV
chmod 600 nim-sync.env
umask 022
echo "已写入（600）"

# ---------- ④ 依赖 ----------
say "安装依赖"
"$NPM" install --omit=dev --no-audit --no-fund \
  --registry=https://registry.npmmirror.com 2>&1 | tail -4

# ---------- ⑤ 起服务 ----------
chmod +x deploy/start-local.sh deploy/macos-install.sh

if [ "${1:-}" = "--launchd" ]; then
  say "装成开机自启"
  bash deploy/macos-install.sh
else
  say "后台启动"
  bash deploy/start-local.sh --bg
  echo
  echo "看状态：curl -s localhost:${NIM_PORT:-8788}/healthz"
  echo "开机自启：cd $APP && bash deploy/macos-install.sh"
  echo "停止：    cd $APP && ./deploy/start-local.sh --stop"
fi
