/**
 * 在播在线人数快照（`nb?` 的数据源）
 * =============================================================
 * 站长 2026-11-15：「nb?group 查询现在在直播的在线人数」「nb?具体成员 就是查询具体成员
 *   现在直播的在线人数，和在看直播的粉丝昵称」。
 *
 * 数据完全走**我们自己的口袋48 官方接口**（`getLiveList`），不依赖 48fan：
 *   liveList[].onlineUserNum   ← 在线人数（72 场实测全部非零）
 *   liveList[].userInfo.nickname / ctime
 * 每轮整份推到 `/api/live/now`（R2 `live:now`，覆盖写，很小），由 worker 端 `nb?` 读。
 *
 * 🔴 只报「场次 id / 昵称 / 在线数 / 开播时间」，**不含任何 uid**。
 * 🔴 粉丝昵称（peers）只可能来自 NIM 长连接里的成员进出事件（live-nim-sync.mjs），
 *    本脚本没有长连接 ⇒ peers 一律为空，`nb?成员` 会如实显示「进入名单还没采到」。
 *
 * 用法：
 *   node live-now-push.mjs
 *   DRY=1 node live-now-push.mjs      # 只打印，不写
 * 环境变量：SITE_URL / INGEST_TOKEN / POCKET48_TOKEN（和别的抓取脚本同一套）
 */
import { postJson } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const DRY = !!process.env.DRY;

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }

function bj(ms) {
  const d = new Date(Number(ms) + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

let list = [];
try {
  const r = await postJson('/live/api/v1/live/getLiveList',
    { debug: true, next: '0', record: false }, { token: TOKEN, retries: 3 });
  list = ((r && r.content && r.content.liveList) || []).filter((x) => x && x.liveId);
} catch (e) {
  console.error('拉在播列表失败：' + String((e && e.message) || e).slice(0, 160));
  process.exit(1);
}

if (!list.length) {
  console.log('当前没有人在播（或接口返回空）');
  process.exit(0);
}

const lives = list.map((x) => {
  const ct = Number(x.ctime) || 0;
  return {
    id: String(x.liveId),
    nick: String((x.userInfo && x.userInfo.nickname) || '').slice(0, 40),
    online: Number(x.onlineUserNum || x.onlineNum || 0) || 0,
    t0: ct > 0 ? (ct < 1e12 ? ct * 1000 : ct) : 0,
  };
});

const total = lives.reduce((a, x) => a + x.online, 0);
console.log(`在播 ${lives.length} 场 · 合计 ${total} 人在线`);
lives.slice().sort((a, b) => b.online - a.online).slice(0, 8)
  .forEach((x, i) => console.log(`  ${i + 1}. ${x.nick} ${x.online}（${x.t0 ? bj(x.t0) + ' 开播' : '开播未知'}）`));

if (DRY) { console.log('(DRY) 不写入'); process.exit(0); }

try {
  const res = await fetch(SITE + '/api/live/now', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ingest-token': INGEST,
      'user-agent': 'all48-live-now/1.0',
    },
    body: JSON.stringify({ lives }),
    signal: AbortSignal.timeout(25000),
  });
  const txt = await res.text();
  console.log('上报 ' + res.status + ' ' + txt.slice(0, 120));
  if (!res.ok) process.exit(1);
} catch (e) {
  console.error('上报失败：' + String((e && e.message) || e).slice(0, 160));
  process.exit(1);
}
