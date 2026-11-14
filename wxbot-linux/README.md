# all48 微信机器人桥 · Intel Mac + Docker 从 0 到 1 部署

> 背景：`@agent-wechat/cli` 官方只发布了 `darwin-arm64`（M 系列 Mac）二进制，
> **Intel Mac（darwin-x64）没有原生包**（全部 111 个版本都没有）。
> 但 `linux-x64` 是官方验证过的成熟产物，所以用 Docker 跑 Linux 容器是最可靠的解法。

---

## 这个文件夹是什么

```
wxbot-linux/                        ← 把这整个文件夹（或同名 zip）拷到 Intel Mac 上
├── README.md                       ← 本说明
├── deploy-docker.sh                ← 一键部署脚本（构建+起容器+自检登录）
├── Dockerfile                      ← Linux 容器定义（Node 22 + 微信 CLI）
├── data-snapshot.tar.gz            ← 🔑 从原机器搬来的登录态（含小号 test48）
└── app/
    └── wxbot/
        ├── agent-wechat-bridge.mjs ← 桥（纯 Node，零第三方依赖）
        ├── agent-wechat.env        ← 配置（WX_BIN=wx 走 PATH，队列 token 等）
        ├── run.sh                  ← 启动桥
        ├── daemon.sh               ← 守护（桥崩 5 秒自愈）
        └── entry.sh                ← 容器入口：先起 wx serve，再起桥
```

- **不需要 `node_modules`**：桥只用 Node 内置模块，零第三方依赖。
- **`data-snapshot.tar.gz` 是登录态**：新机器灌进去就能直接用，**不用重新扫码**。
  这个 snapshot 里的 profile 格式是 `official-linux`，和系统无关，所以能跨机器搬。

---

## 前提：Intel Mac 上装好 Docker Desktop

1. Docker 官网下 **Mac (Intel chip)** 版并安装
2. 打开 Docker Desktop，等右下角图标变绿
3. 终端 `docker version` 能打印 Client/Server 即 OK

---

## 三步部署

### 第 1 步 · 把包弄到 Intel Mac 上

任选一种：

- **AirDrop**：把 `all48-wxbot-docker.zip` 隔空投送到 Intel Mac
- **同一 Wi-Fi 直接下载**：在 Intel Mac 浏览器打开
  `http://<本机内网IP>:8899/all48-wxbot-docker.zip`
  （本机要临时起一个下载服务，用完关掉）

然后在 Intel Mac 上：

```bash
cd ~/Downloads
unzip all48-wxbot-docker.zip -d ~/
cd ~/wxbot-linux
```

### 第 2 步 · 一键部署

```bash
cd ~/wxbot-linux
bash deploy-docker.sh
```

脚本会依次：
1. 检查 Docker 引擎
2. 构建镜像（第一次 3-5 分钟，下 Node 镜像 + 微信 CLI）
3. 把 `data-snapshot.tar.gz` 里的登录态灌到 `./data/`
4. 起容器（`--restart unless-stopped`，开机/崩溃自动拉起）
5. 自检：**已登录就跳过扫码**；没登录才弹二维码让你手机扫
6. 打印桥的启动日志

### 第 3 步 · 验证机器人活了

```bash
docker logs -f all48-wxbot
```

看到 `启动：account=test48 群=全部` 之类就说明桥起来了。
到群里发一条 `lg?王语晨` 试。

---

## 🔴 只能有一台机器在跑

同一个微信号同时被两台机器用，会互相把对方顶下线，群里还可能收到两条重复回复。

**新机器跑通后，旧机器必须停掉：**

```bash
# 老机器（这台 M 系列 Mac）
pkill -f 'agent-wechat-bridg[e].mjs'
```

---

## 日常管理

| 操作 | 命令 |
|---|---|
| 看实时日志 | `docker logs -f all48-wxbot` |
| 停机器人 | `docker stop all48-wxbot` |
| 启动机器人 | `docker start all48-wxbot` |
| 重新扫码登录 | `docker exec -it all48-wxbot wx auth login` |
| 看登录状态 | `docker exec all48-wxbot wx accounts list` |
| 进容器手动调试 | `docker exec -it all48-wxbot bash` |
| 改了 env 后重启 | `docker restart all48-wxbot` |

## 登录态放哪 / 怎么重来

容器里 `HOME=/app/data`，宿主机 `./data` 挂到 `/app/data`，所以登录态落在：

```
./data/.local/share/agent-wechat/          ← 账号、密钥、api-token
./data/xdg/state/wxbot-cursor              ← 桥处理到哪条消息（游标）
./data/wx-serve.log                        ← wx serve 的日志
```

- 容器删了重建：登录态还在，不用重新扫码。
- **想彻底重来**：`docker rm -f all48-wxbot && rm -rf data/.local && bash deploy-docker.sh`
  （会把 snapshot 重新灌一遍；想换微信号就删掉 `data-snapshot.tar.gz` 再跑，然后扫码）

---

## 常见坑

1. **扫了码还是「未登录」**：以前是 `entry.sh` 传了 `--data-dir`，扫码写 A 目录、serve 读 B 目录。
   现在统一不传，走 `$HOME/.local/share/agent-wechat`，两边一致。别自己再给 `wx serve` 加 `--data-dir`。
2. **搬过去的登录态被踢下线**：微信会对异地/换机登录做风控。真被踢了就
   `docker exec -it all48-wxbot wx auth login` 重新扫，之后 login_config 会稳定下来。
3. **桥不推消息**：`WORKER_URL` / `WX_QUEUE_TOKEN` 必须和云端同一个 worker
   （`https://all48-archive.yqz-tansy.workers.dev`），改完 `docker restart all48-wxbot`。
4. **改了群白名单**：编辑 `app/wxbot/agent-wechat.env` 的 `WX_PUSH_MAP` / `WX_GROUPS`，
   然后 `docker restart all48-wxbot`（改 app/ 下的文件需要重新 `docker build`，
   因为镜像里是 COPY 进去的；快速办法：`docker cp` 进容器再 restart）。
5. **Docker 里没声音/不需要麦克风**：`libpulse0` 只在打电话功能用，机器人不用，忽略。

---

## 迁移实录：两个必踩的坑（2026-11-12 首次搬到 Intel Mac 时遇到）

### 坑 1 · `wx serve` 启动就 `No such file or directory (os error 2)`

`registry.sqlite` 里存的是**原机器的绝对路径**：

```sql
-- accounts.profile_path
/Users/tansy/.local/share/agent-wechat/accounts/account-xxx/profile
-- account_settings.keys_file
/Users/tansy/.local/share/agent-wechat/accounts/account-xxx/agent/profile-keys.json
```

搬进容器后这个路径不存在，serve 直接 ENOENT。

**修法**（`deploy-docker.sh` 第 ③ 步已自动做）：把旧前缀替换成容器路径

```bash
sqlite3 data/.local/share/agent-wechat/registry.sqlite "
  UPDATE accounts SET profile_path=replace(profile_path,'<旧前缀>','/app/data/.local/share/agent-wechat');
  UPDATE account_settings SET keys_file=replace(keys_file,'<旧前缀>','/app/data/.local/share/agent-wechat') WHERE keys_file IS NOT NULL;"
```

`entry.sh` 里还有一层兜底：把旧前缀建成符号链接指到当前数据目录（只治 ENOENT，治不了下面的 400）。

### 坑 2 · serve 起来了但桥一直 `400 Bad Request: invalid_request`

daemon 会校验「profile 必须在自己的 data-dir 之下」。只建符号链接不够——registry 里还是 `/Users/...`，
路径字符串对不上就 400。**必须按坑 1 的办法把库里的路径改掉**。

### 坑 3 · `invalid_api_token` / `API bearer token file is missing or invalid`

`api-token` 是 0600 私有文件，wx 会校验属主。从 macOS 挂载进来的文件属主是宿主机 uid（501），
容器里是 root ⇒ 判定「不是我的 token」。`entry.sh` 的做法：
用容器身份把文件重写一遍（换 inode、属主变 root），再复制一份到 `/run/aw/token` 并用
`AGENT_WECHAT_TOKEN_FILE` 指过去。

---

## 验证清单（迁移完成后按顺序跑）

```bash
docker exec all48-wxbot wx accounts list        # 要看到 Authenticated: Yes / Connection: online
docker logs --tail 20 all48-wxbot                # 要看到 [entry] wx serve 就绪
```

群里发一条 `lg?王语晨`，机器人回了就说明整条链路（收消息 → 查 worker → 发消息）全通。

