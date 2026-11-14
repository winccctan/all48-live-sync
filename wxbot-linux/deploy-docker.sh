#!/usr/bin/env bash
# all48 微信机器人桥 · Intel Mac + Docker Desktop 一键部署
# ============================================================
# 用法（在 Intel Mac 上，已装好 Docker Desktop）：
#   cd wxbot-linux
#   bash deploy-docker.sh
#
# 流程：构建镜像 → 灌登录态（有的话）→ 起容器 → 需要时才扫码 → 桥自动跑起来。
# 登录态持久化：挂载到 ./data/，容器删了重建不用重新扫码。
#
# 🔴 同一个微信号只能有一台机器在跑。新机跑起来后，老机器必须停掉桥，
#    否则两边会互相把对方顶下线，且群里可能收到两条重复回复。
set -euo pipefail
cd "$(dirname "$0")"

echo "=== ① 检查 Docker ==="
if ! command -v docker >/dev/null 2>&1; then
  echo "❌ 没找到 docker 命令。请先打开 Docker Desktop，等图标变绿再重跑本脚本。"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "❌ Docker 引擎没跑起来。请打开 Docker Desktop，等右下角图标变绿。"
  exit 1
fi
docker version --format '   Docker {{.Server.Version}} OK'

echo "=== ② 构建 Linux 容器镜像（第一次约 3-5 分钟，要下 Node 镜像和微信 CLI）==="
docker build -t all48-wxbot .

echo "=== ③ 准备数据目录 ==="
mkdir -p data
if [ -f data-snapshot.tar.gz ]; then
  if [ -d data/.local/share/agent-wechat/accounts ] && [ -n "$(ls -A data/.local/share/agent-wechat/accounts 2>/dev/null)" ]; then
    echo "   已有登录态，跳过导入（想重灌就删掉 data/.local 再跑）"
  else
    echo "   导入随包带来的登录态（从原机器搬过来的，含小号 test48）..."
    tar xzf data-snapshot.tar.gz -C data
    echo "   ✅ 导入完成：$(du -sh data/.local/share/agent-wechat | cut -f1)"
  fi
else
  echo "   没有 data-snapshot.tar.gz，稍后需要扫码登录"
fi
# 🔴 修正 registry 里记着的「原机器绝对路径」
#    registry.sqlite 会存 profile / keys 的绝对路径（如 /Users/tansy/.local/share/agent-wechat/...）。
#    不改的话容器里 wx serve 会报 ENOENT (os error 2)，或起来后请求报 400 invalid_request。
REG="data/.local/share/agent-wechat/registry.sqlite"
if [ -f "$REG" ] && command -v sqlite3 >/dev/null 2>&1; then
  OLD_PATH=$(sqlite3 "$REG" "select profile_path from accounts limit 1;" 2>/dev/null || true)
  if [ -n "$OLD_PATH" ]; then
    OLD_PREFIX=$(printf '%s' "$OLD_PATH" | sed -E 's#^(.*/agent-wechat).*$#\1#')
    if [ "$OLD_PREFIX" != "/app/data/.local/share/agent-wechat" ]; then
      echo "   修正 registry 路径：$OLD_PREFIX → /app/data/.local/share/agent-wechat"
      sqlite3 "$REG" "UPDATE accounts SET profile_path=replace(profile_path,'$OLD_PREFIX','/app/data/.local/share/agent-wechat'); UPDATE account_settings SET keys_file=replace(keys_file,'$OLD_PREFIX','/app/data/.local/share/agent-wechat') WHERE keys_file IS NOT NULL;" 2>/dev/null || \
        echo "   ⚠️ 改库失败，容器里会靠符号链接兜底"
    else
      echo "   registry 路径已是容器路径，无需修正"
    fi
  fi
else
  echo "   跳过 registry 修正（没有 sqlite3 或没有库）"
fi

# 容器里是 root，权限放开一点免得读写被拒
chmod -R u+rwX,go-rwx data 2>/dev/null || true
# 挂载进去的脚本必须可执行（entry.sh 是容器的 CMD）
chmod +x app/wxbot/*.sh 2>/dev/null || true

echo "=== ④ 启动容器 ==="
docker rm -f all48-wxbot >/dev/null 2>&1 || true
# 🔴 app/wxbot 直接挂载进容器：以后改指令/改配置，改宿主机文件 + docker restart 即可，不用重新 build
docker run -d --name all48-wxbot \
  --restart unless-stopped \
  -v "$(pwd)/data:/app/data" \
  -v "$(pwd)/app/wxbot:/app/wxbot" \
  all48-wxbot >/dev/null
echo "   容器已启动，等它把 wx serve 拉起来 ..."
for i in $(seq 1 40); do
  if docker exec all48-wxbot wx accounts list >/dev/null 2>&1; then break; fi
  sleep 2
done

echo "=== ⑤ 看登录态 ==="
LOGINED=0
if docker exec all48-wxbot wx accounts list 2>/dev/null | grep -qi 'Authenticated: Yes'; then
  LOGINED=1
  echo "   ✅ 已经登录（用的是搬过来的登录态，不用扫码）"
  docker exec all48-wxbot wx accounts list 2>/dev/null | grep -Ei 'Alias|Own Username|Connection' || true
else
  echo "   ⚠️ 还没登录，需要扫码。"
fi

echo "=== ⑥ 没登录就扫码（手机微信扫终端里的二维码）==="
if [ "$LOGINED" = "0" ]; then
  docker exec -it all48-wxbot wx auth login || {
    echo "⚠️ 扫码没完成。可稍后重试："
    echo "   docker exec -it all48-wxbot wx auth login"
  }
  echo "   重启容器让 wx serve 带上新登录态 ..."
  docker restart all48-wxbot >/dev/null
  sleep 10
fi

echo "=== ⑦ 确认桥跑起来了 ==="
sleep 5
docker logs all48-wxbot 2>&1 | tail -20 || true

echo ""
echo "=========================================="
echo "✅ 部署完成。机器人正在容器里跑。"
echo "   看日志：  docker logs -f all48-wxbot"
echo "   停：      docker stop all48-wxbot"
echo "   重启：    docker start all48-wxbot"
echo "   重新扫码：docker exec -it all48-wxbot wx auth login"
echo ""
echo "🔴 现在请把老机器上的桥停掉（否则同一个号两边抢，会互相顶下线）："
echo "   pkill -f 'agent-wechat-bridg[e].mjs'"
echo "=========================================="
