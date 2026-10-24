# 直播侧礼物实时监听 · 部署（国内常驻机）

> 房间侧（成员房间里的送礼）已经在跑，2 分钟一轮，跑在 GitHub Actions 上。
> **这份文档只管直播侧**：口袋48 的直播间送礼不进房间 IM，只能靠云信 NIM 长连接。

## 为什么必须是国内机器

两条链路都卡地域：

| 环节 | 海外出口的实际结果 |
|---|---|
| `pocketapi.48.cn` 在播列表 / getLiveOne | 直连 403（GitHub Actions 实测），只能用 `SCRAPE_PROXY` 中转 |
| 云信 NIM 登录 | 能过（`accid` / `pwd` 都拿得到） |
| 云信 NIM **进房 WS** | **403 断开**（Azure 美东、日本家宽都试过） |

HTTP 代理能中转普通请求，但**穿不透 WebSocket 长连接**，所以这条链路没有「代理」方案，
只能放在国内 IP 上直接跑。

## 一次性安装（Debian / Ubuntu）

把 `all48-live-sync` 整个目录（`live-nim-sync.mjs` + `lib/` + `package.json` + `deploy/`）传到机器上，然后：

```bash
cd all48-live-sync
sudo SITE_URL=https://all48.wyc0518.cc \
     INGEST_TOKEN='<和 Worker secret INGEST_TOKEN 一致>' \
     POCKET48_TOKEN='<口袋48 token>' \
     bash deploy/install.sh
```

脚本做四件事：装 Node 20（已有 ≥18 就跳过）→ 拷到 `/opt/all48-live-sync` + `npm i` →
写 `/opt/all48-live-sync/nim-sync.env`（600 权限）→ 装 systemd 服务并启动，最后打印状态与 healthz。

升级就再跑一遍同样的命令（不动 env）。

## 第一次跑起来要看什么

```bash
journalctl -u all48-nim-sync -f
```

按顺序应该看到：

1. `目标礼物「弦月回响」` ← 站点配置读到了
2. `成员目录 N 人` ← 直播弹幕只有昵称，靠它归户
3. `NIM 凭证 accid=...` ← 登录口袋48 通过
4. `节点探测：xxx=OK` ← 云信 WS 节点能连（**这一步海外机器必挂**）
5. `✅ [成员名] 进房成功 roomId=...` ← 真正进了直播间
6. `🎁 [直播] 成员 ← 送礼人 1 个「弦月回响」` ← 收到目标礼物（要等活动里有人送）

```bash
curl -s localhost:8788/healthz | head -40
```

关键字段：

| 字段 | 正常 | 不正常的意思 |
|---|---|---|
| `link` | 非空节点名 | 空 = 节点全不通，这台机器出口不对 |
| `tokenBad` | `false` | `true` = 口袋 token 过期 / 出口 IP 被拦 |
| `stats.msgs` | 一直在涨 | 不涨 = 没进到房 / 房间里没人说话 |
| `stats.hits` | 活动期间会涨 | 一直 0 = 要么真没人送，要么解析没认出来（见下） |
| `roomsMax` | `all` | 数字 = 只监听前 N 场（`NIM_ROOMS_MAX`）；设 0 才是全部 |
| `unstable` | `0` | >0 = 有房间连续进房即断（多半是同一 accid 多连接被踢，先降 `NIM_ROOMS_MAX` 到 8~12 试，仍踢则需多账号） |
| `rooms[].state` | `on` | `down/entering` 反复 = 该房间进不去 |

## 认不出礼物怎么办（NIM_DUMP）

NIM 里口袋的自定义消息结构没有官方文档，解析器是**按字段名宽匹配**的
（`giftName/giftNum/acceptUserName` → 退化到 `送给X N个礼物` 正则）。
如果 `stats.msgs` 在涨但 `hits` 恒 0，说明结构没对上：

```bash
# 1) 打开采样，重启
sed -i 's/^# NIM_DUMP=1/NIM_DUMP=1/' /opt/all48-live-sync/nim-sync.env   # 没有就手动加一行
systemctl restart all48-nim-sync
# 2) 攒几分钟，看采样文件（每个房间最多 200 条）
ls /var/lib/all48-nim/samples/
head -3 /var/lib/all48-nim/samples/*.jsonl
```

采样里有 `raw` 字段就是整条消息的原文，照它补 `parseGift()` 的字段名即可。
`NIM_DUMP` 校准完记得去掉，别长期开着写盘。

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 日志 `节点全部不通` | 机器不是国内出口 / 防火墙封 443 | 换机器；或 `iptables -L` 看出口规则 |
| 日志 `在播列表失败 ... 403` | 口袋48 按 IP 拦 | 确认是国内 IP；家宽动态 IP 变了要重拨 |
| `tokenBad: true` | `POCKET48_TOKEN` 过期 | 重新拿 token，改 `nim-sync.env`，`systemctl restart` |
| `unstable` 一直涨 | 同 accid 多连接互踢 | 先 `NIM_ROOMS_MAX=8~12` 观察；仍涨说明单账号撑不住，得拆多账号（每个账号一套 `POCKET48_TOKEN` → 各自 accid/pwd，分房间跑多个进程） |
| 收到礼物但榜单没变 | `mid` 归户失败（昵称不在成员目录） | 日志里会有 `直播礼物归户失败：「X」不在成员目录里` |
| 进程反复重启 | 依赖没装好 | `cd /opt/all48-live-sync && npm i --omit=dev` 看报错 |

## macOS 机器（没有 systemd）

用 launchd，或者最省事用 `tmux`/`screen` 挂着（不推荐长期）：

```bash
npm i @yxim/nim-web-sdk xhr2 --no-audit --no-fund
SITE_URL=... INGEST_TOKEN=... POCKET48_TOKEN=... node live-nim-sync.mjs
```

长期跑写个 `~/Library/LaunchAgents/cc.wyc0518.all48-nim.plist`（`KeepAlive=true`），日志重定向到 `~/Library/Logs/all48-nim.log`。

## 它和回放通道的关系

| 通道 | 脚本 | 覆盖 | 延迟 |
|---|---|---|---|
| **实时**（本文档） | `live-nim-sync.mjs` | 在播直播间，NIM 长连接 | 秒级 |
| 回放兜底 | `live-gift-sync.mjs`（sync.yml 的 `livegift` job） | 已结束场次的弹幕 LRC | 播完 + 最多 15 分钟 |

两条通道写同一个 R2 天文件，去重键含 `src=1`，**不会重复计分**。
实时通道挂了，回放通道仍会把这场补回来（只要 LRC 写全了）。
