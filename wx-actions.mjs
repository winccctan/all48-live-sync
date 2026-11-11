/**
 * 微信推送 · GitHub Actions 版（2026-11-12）
 * =====================================================
 * 为什么有这一版：站长不想依赖自己电脑常开，也不想为这事儿买服务器。
 * 仓库是 public ⇒ Actions 分钟数完全免费、不用绑卡 ⇒ 这是唯一「零成本 + 零门槛」的常驻方案。
 *
 * 数据流（全链路无服务器）：
 *   口袋48(getLiveList / 房间消息)
 *     → 本脚本（GitHub runner 里跑 ~4.5 分钟）
 *     → Cloudflare Worker 的 KV 队列 POST /api/wxq/push
 *     → 手机 AutoJS6 每 20 秒 GET /api/wxq 取件 → 发到「游戏群」
 *
 * 🔴 游标不放本地（runner 每次都是全新机器），统一放 Worker 的 wx:state：
 *    roomT   房间消息游标（毫秒）
 *    liveId  当前在播场次（空 = 没在播）
 *    miss    连续几次没在列表里（连续 3 次才算真下播，防抖）
 *
 * 🔴 只推「她本人」：extInfo.channelRole === '2'；跳过 LIVEPUSH（开播归本脚本的 live 分支管）。
 *
 * 用法（本地调试）：
 *   DRY=1 RUN_SECONDS=60 node wx-actions.mjs    # 只打印不投递
 *   node wx-actions.mjs                          # 跑一轮（默认 270 秒）
 */
import { postJson, fetchMessagePage } from './lib/api.mjs';

const WORKER = (process.env.WORKER_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const WATCH_UID = String(process.env.WATCH_UID || '89653517');   // 王语晨
const NICK = process.env.ROOM_NICK || '王语晨';
const SRV = String(process.env.ROOM_SRV || '2278592');
const CH = String(process.env.ROOM_CH || '2541547');
const RUN = Math.max(45, Number(process.env.RUN_SECONDS || 270)) * 1000;
const EVERY = Math.max(10, Number(process.env.EVERY || 20)) * 1000;
const DRY = !!process.env.DRY;
const HDR = { 'x-ingest-token': INGEST, 'content-type': 'application/json' };

const BJ = 8 * 3600e3;
const p2 = (n) => String(n).padStart(2, '0');
function bjTime(ms, withDate) {
  const d = new Date((Number(ms) || Date.now()) + BJ);
  const hm = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  return withDate === false ? hm : `${d.getUTCMonth() + 1}-${p2(d.getUTCDate())} ${hm}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }
if (!INGEST && !DRY) { console.error('缺 INGEST_TOKEN'); process.exit(1); }

/* ---------------- Worker 侧游标 / 队列 ---------------- */

async function stateGet() {
  const r = await fetch(`${WORKER}/api/wxq/state`, { headers: HDR, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('读游标 HTTP ' + r.status);
  const j = await r.json();
  const s = j && (j.state || j.data || j);
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
}

async function push(items, state) {
  if (DRY) {
    for (const it of items) log('[DRY] 会推：' + it.text.replace(/\n/g, ' / '));
    log('[DRY] state =', JSON.stringify(state));
    return;
  }
  const r = await fetch(`${WORKER}/api/wxq/push`, {
    method: 'POST', headers: HDR,
    body: JSON.stringify({ items, state }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('投递 HTTP ' + r.status);
  const j = await r.json();
  if (j && j.added) log(`已入队 ${j.added} 条，队列共 ${j.q}`);
  return j;
}

/* ---------------- 数据源 ---------------- */

async function getLives() {
  const j = await postJson('/live/api/v1/live/getLiveList',
    { debug: false, next: '0', groupId: 12, record: false }, { token: TOKEN, retries: 2 });
  const list = (j && j.content && Array.isArray(j.content.liveList)) ? j.content.liveList : [];
  return list.map((x) => {
    const ui = x.userInfo || {};
    return {
      liveId: String(x.liveId || ''),
      uid: String(ui.userId || ''),
      name: String(ui.starName || ui.realNickName || ui.nickname || '').replace(/^[A-Z]+48-/, ''),
      title: String(x.title || ''),
      ctime: Number(x.ctime) || 0,
    };
  }).filter((x) => x.uid && x.liveId);
}

/** 一条 IM 消息 → {t,text} ；返回 null 表示不推 */
function line(m) {
  let ext = {};
  try { ext = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : (m.extInfo || {}); } catch { ext = {}; }
  if (String(ext.channelRole) !== '2') return null;        // 不是她本人
  const type = String(m.msgType || '');
  if (type === 'LIVEPUSH' || type === 'GIFT') return null;  // 开播另管 / 礼物不推

  let body = '';
  try { body = typeof m.bodys === 'string' ? m.bodys : JSON.stringify(m.bodys || {}); } catch { body = ''; }
  let content = '';
  if (type === 'TEXT') content = String(body || '').trim();
  else if (type === 'IMAGE') content = '[图片]';
  else if (type === 'AUDIO' || type === 'VOICE') {
    let sec = 0;
    try { sec = Number(JSON.parse(body).duration) || 0; } catch { }
    content = '[语音' + (sec ? ' ' + Math.round(sec / 1000) + '秒' : '') + ']';
  } else if (type === 'EXPRESSION' || type === 'EMOJI') content = '[表情]';
  else return null;

  if (!content) return null;
  return { t: Number(m.msgTime) || 0, text: content };
}

/** 取 since 之后本人发的消息（最多往回翻 6 页，避免 runner 时间被吃光） */
async function collect(since) {
  const out = [];
  let nextTime = 0;
  for (let p = 0; p < 6; p++) {
    const r = await fetchMessagePage({ serverId: SRV, channelId: CH, nextTime, limit: 50, token: TOKEN });
    const msgs = (r && r.messages) || [];
    if (!msgs.length) break;
    let oldest = Infinity;
    for (const m of msgs) {
      const it = line(m);
      const t = Number(m.msgTime) || 0;
      if (t && t < oldest) oldest = t;
      if (!it) continue;
      if (it.t && it.t > since) out.push(it);
    }
    // 这一页里最早的消息都已经比游标新 ⇒ 还得继续往前翻
    if (!(oldest > since)) break;
    if (!r.nextTime || r.nextTime === nextTime) break;
    nextTime = r.nextTime;
    await sleep(150);
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ---------------- 一轮 ---------------- */

async function tick(st, first) {
  const items = [];
  const next = { ...st };

  /* ① 开播 / 下播 */
  let cur = null;
  try {
    const list = await getLives();
    cur = list.find((x) => x.uid === WATCH_UID) || null;
    /* 🔴 首轮必须打这一行：这是「runner 出口能不能直连口袋48」的唯一证据。
       打出来 = 数据源通；打不出来（或紧跟着「查直播失败」）= 出口被拦，得换机房。 */
    if (first) log(`数据源 OK：全站在播 ${list.length} 个，她在${cur ? '播「' + cur.title + '」' : '没在播'}`);
  } catch (e) {
    next.err = 'live:' + String(e.message || e).slice(0, 60);
    log('查直播失败：' + next.err);
  }

  if (cur) {
    next.miss = 0;
    /* 🔴 第一次跑（游标里没有 liveId）时如果她早就播了，不能补发「开播」——
       否则每台新机器上线都会在群里诈一句「开播了」，而直播可能已经播了两小时。
       口径跟 live-notify.mjs 一致：>30 分钟的直接静默记录。 */
    const startedAgo = cur.ctime ? Date.now() - cur.ctime : 0;
    const coldStart = !st.liveId && startedAgo > 30 * 60e3;
    if (cur.liveId !== (st.liveId || '') && !coldStart) {
      const mins = cur.ctime ? Math.max(0, Math.round((Date.now() - cur.ctime) / 60000)) : 0;
      items.push({
        id: 'live:' + cur.liveId + ':start',
        t: Date.now(),
        text: `【${NICK}·开播】${cur.title || '直播中'}\n`
          + (mins > 5 ? `已经播了 ${mins} 分钟\n` : '')
          + `https://h5.48.cn/2017/live/index.html?liveId=${cur.liveId}`,
      });
      log(`开播 → ${cur.liveId} 「${cur.title}」`);
    }
    next.liveId = cur.liveId;
    next.liveTitle = cur.title;
    next.liveCtime = cur.ctime;
  } else if (st.liveId) {
    const miss = (Number(st.miss) || 0) + 1;
    next.miss = miss;
    if (miss >= 3) {                       // 连续 3 次（≈1 分钟）都没在列表里才算真下播
      const mins = st.liveCtime ? Math.max(1, Math.round((Date.now() - st.liveCtime) / 60000)) : 0;
      items.push({
        id: 'live:' + st.liveId + ':end',
        t: Date.now(),
        text: `【${NICK}·下播】${mins ? '这场播了 ' + mins + ' 分钟' : '直播结束'}`,
      });
      log(`下播 → ${st.liveId}，播了 ${mins} 分钟`);
      next.liveId = '';
      next.liveTitle = '';
      next.liveCtime = 0;
      next.miss = 0;
    }
  }

  /* ② 房间消息（只推她本人） */
  const now = Date.now();
  // 游标为空（第一次跑）或落后太多 ⇒ 只补最近 10 分钟，绝不把整段历史倒进群
  const floor = now - 10 * 60e3;
  const since = Math.max(Number(st.roomT) || 0, floor);
  try {
    const msgs = await collect(since);
    if (first) log(`消息源 OK：最近 10 分钟她有 ${msgs.length} 条本人发言`);
    if (msgs.length) {
      const newest = msgs[msgs.length - 1].t;
      if (msgs.length === 1) {
        items.push({
          id: 'room:' + msgs[0].t,
          t: msgs[0].t,
          text: `【${NICK}·口袋房间】${bjTime(msgs[0].t)}\n${msgs[0].text}`,
        });
      } else {
        const lines = msgs.map((it) => `${bjTime(it.t, false)}  ${it.text}`).join('\n');
        items.push({
          id: 'room:' + newest,
          t: newest,
          text: `【${NICK}·口袋房间】${msgs.length} 条新消息\n${lines}`,
        });
      }
      next.roomT = newest;
      log(`房间消息 ${msgs.length} 条，最新 ${bjTime(newest)}`);
    } else if (!st.roomT) {
      next.roomT = now;                    // 没有历史可补也要落游标
    }
  } catch (e) {
    next.err = 'room:' + String(e.message || e).slice(0, 60);
    log('查房间消息失败：' + next.err);
  }

  if (items.length) delete next.err;
  next.at = Date.now();
  await push(items, next);
  return next;
}

/* ---------------- 主循环 ---------------- */

const until = Date.now() + RUN;
log(`启动：盯 ${NICK}(${WATCH_UID})，跑 ${Math.round(RUN / 1000)} 秒，每 ${Math.round(EVERY / 1000)} 秒一次`);

let st = {};
try { st = await stateGet(); } catch (e) {
  st = { err: 'state:' + String(e.message || e).slice(0, 60) };
  log('读游标失败（本轮从头算）：' + st.err);
}
log('游标 =', JSON.stringify(st));

let n = 0;
while (Date.now() < until) {
  n++;
  try { st = await tick(st, n === 1); } catch (e) {
    log('本轮异常：' + String(e.message || e).slice(0, 120));
    st = { ...st, at: Date.now(), err: String(e.message || e).slice(0, 60) };
    try { await push([], st); } catch { }
  }
  const left = until - Date.now();
  if (left <= 0) break;
  await sleep(Math.min(EVERY, left));
}
log(`结束，共 ${n} 轮`);
