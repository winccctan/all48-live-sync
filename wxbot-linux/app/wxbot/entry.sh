#!/usr/bin/env bash
# all48 微信机器人桥 · Linux 容器启动入口
# ============================================================
# 职责：先拉起 agent-wechat 的 wx serve（登录态 daemon，走 HTTP API），
#       再跑 daemon.sh（桥崩了自动重启）。
#
# 🔴 数据目录必须三处一致，否则表现是「扫了码还是未登录」：
#    ① wx serve（本脚本，显式 --data-dir = 默认值）
#    ② wx auth login（不带参数，走 $HOME/.local/share/agent-wechat）
#    ③ 桥脚本里的 wx 调用（不带参数，同样走默认值）
#    Dockerfile 里 HOME=/app/data ⇒ 三者都是 /app/data/.local/share/agent-wechat。
#    宿主机上对应 ./data/.local/share/agent-wechat（整个 HOME 都挂载了）。
#
# 🔴 api-token 是 0600 的私有文件，wx 会校验属主。从 macOS 挂载进来的文件
#    属主是宿主机 uid（501），容器里是 root ⇒ 一律报
#    {"code":"invalid_api_token","message":"API bearer token file is missing or invalid"}。
#    解法（双保险）：
#      a) 用容器自己的身份**重写**一遍该文件（新 inode ⇒ 属主变成 root）；
#      b) 再复制一份到容器可写区 /run/aw/token，用 AGENT_WECHAT_TOKEN_FILE 指过去。
set -uo pipefail
cd /app/wxbot

export HOME=/app/data
DATA_DIR="$HOME/.local/share/agent-wechat"
PORT=6174
RUNTIME_TOKEN=/run/aw/token

port_up() {
  node -e "
    const s = require('net').connect($PORT, '127.0.0.1');
    s.on('connect', () => { s.destroy(); process.exit(0); });
    s.on('error', () => process.exit(1));
    setTimeout(() => process.exit(1), 800);
  " 2>/dev/null
}

# ① 修正 api-token 的归属，并做一份 root 自有的运行时副本
prepare_token() {
  mkdir -p "$DATA_DIR" "$(dirname "$RUNTIME_TOKEN")"
  local src="$DATA_DIR/api-token"
  local tmp="$DATA_DIR/.api-token.rebuild"

  if [ ! -s "$src" ]; then
    echo "[entry] 挂载区还没有 api-token，交给 daemon 生成"
    return 1
  fi

  # a) 读出来（能读到说明内容没问题，只是属主/权限不对）
  if ! cat "$src" > "$tmp" 2>/dev/null || [ ! -s "$tmp" ]; then
    echo "[entry] ⚠️ 连读都读不了 $src，交给 daemon 重建"
    rm -f "$tmp" 2>/dev/null || true
    return 1
  fi
  # b) 用容器身份重写原位置 ⇒ 新 inode、属主 root、0600
  if mv -f "$tmp" "$src" 2>/dev/null; then
    chmod 600 "$src" 2>/dev/null || true
    echo "[entry] api-token 已按容器属主重写"
  else
    echo "[entry] ⚠️ 挂载区不可写，改用运行时副本"
    rm -f "$tmp" 2>/dev/null || true
  fi

  # c) 再放一份 root 自有的运行时副本（挂载区权限再怪也不怕）
  if cp -f "$src" "$RUNTIME_TOKEN" 2>/dev/null && [ -s "$RUNTIME_TOKEN" ]; then
    chmod 600 "$RUNTIME_TOKEN" 2>/dev/null || true
    chown 0:0 "$RUNTIME_TOKEN" 2>/dev/null || true
  fi
  return 0
}

# ② 修复 registry 里记着的「原机器绝对路径」
#    registry.sqlite 会存 profile 的绝对路径，例如
#    /Users/tansy/.local/share/agent-wechat/accounts/<id>/profile
#    搬到容器后这个路径不存在 ⇒ serve 启动直接 ENOENT (os error 2)。
#    做法：把旧前缀在容器里建成符号链接，指到当前 data 目录。
REPAIR_OLD=""
repair_old_paths() {
  local reg="$DATA_DIR/registry.sqlite"
  [ -f "$reg" ] || return 0
  local found
  found=$(grep -a -o '/Users/[A-Za-z0-9_./-]*' "$reg" 2>/dev/null | head -1)
  [ -n "$found" ] || return 0
  # 截到 .../agent-wechat 为止
  REPAIR_OLD=$(printf '%s' "$found" | sed -E 's#^(.*/agent-wechat).*$#\1#')
  [ -n "$REPAIR_OLD" ] || return 0
  [ "$REPAIR_OLD" = "$DATA_DIR" ] && { echo "[entry] registry 路径已是容器路径，无需修复"; return 0; }
  if [ -e "$REPAIR_OLD" ] && [ ! -L "$REPAIR_OLD" ]; then
    echo "[entry] ⚠️ $REPAIR_OLD 已存在且不是符号链接，跳过修复"
    return 0
  fi
  mkdir -p "$(dirname "$REPAIR_OLD")" 2>/dev/null || true
  ln -sfn "$DATA_DIR" "$REPAIR_OLD" 2>/dev/null \
    && echo "[entry] 已建立兼容链接：$REPAIR_OLD -> $DATA_DIR" \
    || echo "[entry] ⚠️ 建符号链接失败：$REPAIR_OLD"
}

# ③ 起 wx serve（登录态 daemon）
repair_old_paths || true

if port_up; then
  echo "[entry] wx serve 已在运行 (127.0.0.1:$PORT)"
  prepare_token >/dev/null 2>&1 || true
else
  echo "[entry] 启动 wx serve ..."
  if prepare_token; then
    TOKEN_ARG="--token-file $RUNTIME_TOKEN"
  else
    TOKEN_ARG="--token-file $DATA_DIR/api-token"
  fi
  wx serve --data-dir "$DATA_DIR" --listen 127.0.0.1:$PORT $TOKEN_ARG \
    > /app/data/wx-serve.log 2>&1 &
  echo "[entry] wx serve 已拉起 (pid $!)  token=$TOKEN_ARG"
  for i in $(seq 1 30); do
    if port_up; then echo "[entry] wx serve 就绪"; break; fi
    sleep 1
  done
  port_up || {
    echo "[entry] ⚠️ wx serve 30 秒没起来，看 /app/data/wx-serve.log："
    tail -20 /app/data/wx-serve.log 2>/dev/null || true
  }
fi

# ③ 兜底：daemon 是新建 token 的情况，同步一份运行时副本
if [ ! -s "$RUNTIME_TOKEN" ] && [ -s "$DATA_DIR/api-token" ]; then
  cp -f "$DATA_DIR/api-token" "$RUNTIME_TOKEN" 2>/dev/null \
    && chmod 600 "$RUNTIME_TOKEN" 2>/dev/null || true
fi
if [ -s "$RUNTIME_TOKEN" ]; then
  export AGENT_WECHAT_TOKEN_FILE="$RUNTIME_TOKEN"
  echo "[entry] AGENT_WECHAT_TOKEN_FILE=$RUNTIME_TOKEN"
fi

# ④ 登录态自检（只提示，不阻断）
#    🔴 这里只是"读状态"，服务刚起来时 accounts 可能还没就绪，
#       所以判不出来也只给中性提示，不能说"未登录"吓人。
ACCT_STATUS=$(wx accounts list 2>/dev/null || true)
if printf '%s' "$ACCT_STATUS" | grep -qiE 'Authenticated: Yes|Connection: online'; then
  echo "[entry] ✅ 账号已登录"
else
  echo "[entry] 登录状态暂未读到（能正常收发消息就不用管；要重扫才用 wx auth login）"
fi

# ⑤ 起桥守护（5 秒自愈）
echo "[entry] 启动桥守护 ..."
exec bash /app/wxbot/daemon.sh
