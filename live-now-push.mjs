/**
 * 在播在线人数快照（`nb?` 的数据源）
 * =============================================================
 * 🔴 2026-11-15 站长：「图是别人的直播在线人数，我们和他们差太多了，我们这个查询肯定有问题」——确实。
 *
 * 旧做法用的是 `getLiveList.onlineUserNum` / `getLiveOne.onlineNum`，实测**不是人数**：
 *   同一场（李子忻）4 分钟里 8692 → 8704 → 8773 单调上涨；同一时刻她的真实在线只有 60 来人。
 *   证据（同一时刻对照）：
 *     场次        口袋 onlineNum   聊天室在线
 *     卢美廷           520            33
 *     秦露丹           232            49
 *     张倩            3063            64      ← 对方榜单上 63
 *   ⇒ 口袋那个值是「热度」，会随时间累加；真正的「此刻多少人待在房间」只有云信聊天室
 *     （NIM `ChatRoomInfo.onlineMemberNum`）有，也就是 App 里显示的那个数。
 *
 * 本脚本：拉在播列表 → 每场 `getLiveOne` 取 roomId → 连进聊天室读 onlineMemberNum → 断开。
 *   online = 聊天室在线人数（人）    heat = 口袋 onlineNum（热度，留档对照，不当人数用）
 *
 * 🔴 账号：必须用**第二个口袋小号**。账号 1 进任何直播间聊天室恒 416（无权限/被限），
 *    账号 2 实测能进。凭证优先取环境变量 NIM2_ACCID / NIM2_PW，
 *    没有就从 `/api/live/nimcred`（ingest 口令鉴权）取 —— 这样 Actions 不用多加 secret。
 * 🔴 只推「场次 id / 昵称 / 在线人数 / 热度 / 开播时间」，**不含任何 uid**。
 *
 * 用法：
 *   node live-now-push.mjs
 *   DRY=1 node live-now-push.mjs          # 只打印，不写
 *   LIMIT=5 node live-now-push.mjs        # 只测前 5 场
 * 环境变量：SITE_URL / INGEST_TOKEN / POCKET48_TOKEN / NIM2_ACCID / NIM2_PW
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { postJson } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const DRY = !!process.env.DRY;
const LIMIT = Number(process.env.LIMIT) || 0;
/* 并发：云信对单账号同时进房数有上限，6 路实测稳；再多容易 416/超时 */
const CONC = Math.max(1, Math.min(10, Number(process.env.NIM_CONC) || 6));
const PER_ROOM_MS = 9000;

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }

const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';

/* 云信客户端在本仓库里（CJS），ESM 走 createRequire */
const require = createRequire(import.meta.url);
const { createNimCommonlinkChatroomClient } = require('./nim-client/chatroom.cjs');

function bj(ms) {
  const d = new Date(Number(ms) + 8 * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
}

/* ---------------------------------------------------------------- ① 凭证 */
async function nimCred() {
  const a = String(process.env.NIM2_ACCID || '').trim();
  const p = String(process.env.NIM2_PW || '').trim();
  if (a && p) return { accid: a, pwd: p, from: 'env' };
  /* Actions 里没有 NIM2_* secret ⇒ 从 worker 取（ingest 口令保护） */
  try {
    const r = await fetch(SITE + '/api/live/nimcred', {
      headers: { 'x-ingest-token': INGEST, 'user-agent': 'all48-live-now/2.0' },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    if (j && j.ok && j.accid && j.pwd) return { accid: j.accid, pwd: j.pwd, from: 'site' };
    console.warn('取 NIM 凭证失败：' + JSON.stringify(j).slice(0, 120));
  } catch (e) {
    console.warn('取 NIM 凭证异常：' + String((e && e.message) || e).slice(0, 120));
  }
  return null;
}

/* ---------------------------------------------------------------- ② 在播列表 */
async function liveList() {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await postJson('/live/api/v1/live/getLiveList',
        { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
      const list = ((r && r.content && r.content.liveList) || []).filter((x) => x && x.liveId);
      if (list.length) return list;
      /* debug 模式偶尔返回空（实测），退到普通列表（只 20 条，但至少有数） */
      const r2 = await postJson('/live/api/v1/live/getLiveList', { next: '0' }, { token: TOKEN, retries: 2 });
      const list2 = ((r2 && r2.content && r2.content.liveList) || []).filter((x) => x && x.liveId);
      if (list2.length) return list2;
    } catch (e) {
      console.warn('拉在播列表失败（第 ' + (i + 1) + ' 次）：' + String((e && e.message) || e).slice(0, 120));
    }
    await new Promise((z) => setTimeout(z, 2500));
  }
  return [];
}

/* ---------------------------------------------------------------- ③ 单场：roomId + 聊天室在线 */
async function oneRoom(cred, liveId) {
  let roomId = '';
  let heat = 0;
  try {
    const r = await postJson('/live/api/v1/live/getLiveOne', { liveId: String(liveId) }, { token: TOKEN, retries: 1 });
    const c = (r && r.content) || {};
    roomId = String(c.roomId || '');
    heat = Number(c.onlineNum) || 0;
  } catch { /* 拿不到就当作读不到 */ }
  if (!roomId) return { roomId: '', heat, online: null, err: 'no-room' };

  const cli = createNimCommonlinkChatroomClient({
    appKey: APPKEY, account: cred.accid, token: cred.pwd, roomId,
  });
  try {
    await cli.connect();
    const info = await cli.getChatroomInfo();
    const n = typeof info === 'number' ? info : Number(info && info.onlineMemberNum);
    return { roomId, heat, online: Number.isFinite(n) ? n : null, err: '' };
  } catch (e) {
    return { roomId, heat, online: null, err: String((e && e.message) || e).slice(0, 60) };
  } finally {
    try { cli.destroy(); } catch { /* noop */ }
  }
}

/** 限并发跑一批 */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------------------------------------------- ④ 主流程 */
const cred = await nimCred();
if (!cred) {
  console.error('没有可用的云信账号，退出（在线人数只能从聊天室拿，不能用热度顶替）');
  process.exit(1);
}

let list = await liveList();
if (!list.length) { console.log('当前没有人在播（或接口返回空）'); process.exit(0); }
if (LIMIT) list = list.slice(0, LIMIT);
console.log('在播 ' + list.length + ' 场 · 账号 ' + cred.accid + '（' + cred.from + '）· 并发 ' + CONC);

const t0 = Date.now();
const res = await pool(list, CONC, async (x) => {
  const liveId = String(x.liveId);
  const r = await oneRoom(cred, liveId);
  return { x, ...r };
});
const cost = ((Date.now() - t0) / 1000).toFixed(1);

const lives = res.map(({ x, online, heat, err }) => {
  const ct = Number(x.ctime) || 0;
  return {
    id: String(x.liveId),
    nick: String((x.userInfo && x.userInfo.nickname) || '').slice(0, 40),
    /* 聊天室读不到就报 0（宁可少，不拿热度冒充人数） */
    online: Number.isFinite(online) ? online : 0,
    heat: heat || 0,
    t0: ct > 0 ? (ct < 1e12 ? ct * 1000 : ct) : 0,
    _err: err,
  };
});

const okN = lives.filter((x) => !x._err).length;
const total = lives.reduce((a, x) => a + x.online, 0);
const totalHeat = lives.reduce((a, x) => a + x.heat, 0);
console.log(`聊天室读到 ${okN}/${lives.length} 场 · 合计在线 ${total.toLocaleString('en-US')} 人 · 热度合计 ${totalHeat.toLocaleString('en-US')} · 用时 ${cost}s`);
lives.filter((x) => x._err).slice(0, 5).forEach((x) => console.log(`  ✗ ${x.nick} ${x._err}`));
lives.slice().sort((a, b) => b.online - a.online).slice(0, 8)
  .forEach((x, i) => console.log(`  ${i + 1}. ${x.nick} ${x.online} 人（热度 ${x.heat}）${x.t0 ? ' ' + bj(x.t0) + ' 开播' : ''}`));

if (DRY) { console.log('(DRY) 不写入'); process.exit(0); }

for (const x of lives) delete x._err;
try {
  const r = await fetch(SITE + '/api/live/now', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ingest-token': INGEST,
      'user-agent': 'all48-live-now/2.0',
    },
    body: JSON.stringify({ lives }),
    signal: AbortSignal.timeout(30000),
  });
  const txt = await r.text();
  console.log('上报 ' + r.status + ' ' + txt.slice(0, 120));
  if (!r.ok) process.exit(1);
} catch (e) {
  console.error('上报失败：' + String((e && e.message) || e).slice(0, 160));
  process.exit(1);
}
