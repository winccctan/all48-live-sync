# all48 微信机器人桥 · Linux 容器（Intel Mac 用 Docker Desktop 跑）
# ============================================================
# 为什么用 Docker：
#   @agent-wechat/cli 官方只发了 darwin-arm64（M 系列 Mac），
#   Intel Mac（darwin-x64）没有原生二进制；Linux x64 是官方验证过的成熟产物。
#   Intel Mac 上装 Docker Desktop，跑这个 Linux 容器即可完美绕过。
#
# 构建（build context = wxbot-linux/ 目录）：
#   docker build -t all48-wxbot .
# 运行：
#   docker run -d --name all48-wxbot \
#     -v $(pwd)/data:/app/data \
#     all48-wxbot
#
# 首次需进容器扫码登录：docker exec -it all48-wxbot wx auth login
FROM node:22-slim

# procps：daemon.sh 用 pkill 清旧桥；curl 方便进容器里手动排障
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# agent-wechat 官方 CLI（Linux x64/arm64 都有，glibc 2.36+）
RUN npm install -g @agent-wechat/cli@2.3.2

# 桥脚本（纯 Node，零第三方依赖）
WORKDIR /app
COPY app/wxbot /app/wxbot
RUN chmod +x /app/wxbot/run.sh /app/wxbot/daemon.sh /app/wxbot/entry.sh

# 登录态/游标/日志都放 /app/data（宿主机挂载持久化）
RUN mkdir -p /app/data
ENV HOME=/app/data

# 入口：先起 wx serve，再起桥守护
CMD ["/app/wxbot/entry.sh"]
