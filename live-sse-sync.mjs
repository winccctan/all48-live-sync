#!/usr/bin/env node
/**
 * live-sse-sync.mjs —— 直播中「实时」采集弦月回响（消费 48fan 的 SSE 弹幕流）
 *
 * ── 为什么是这个方案（2026-10-25 打穿，别再走回头路）──────────────────────
 * 口袋48 自己的 NIM 长连接我们连不上：匿名 / IM SDK / node-nim / 日本 / 杭州出口
 * 全部 403（连**错 token 也 403** ⇒ 是应用级拒绝，不是凭证或出口问题）。
 * 而 48fan 把 NIM 消息转成了 HTTP SSE，公开可消费：
 *
 *   ① POST /api/live-hls/member/<liveId>/start   body {"clientId": uuid}
 *        → {"ok":true,"mode":"copy","url":"/api/live-hls/member/<liveId>/index.m3u8"}
 *        🔴 这是「观看会话」，不 start 直接开 SSE 会被 403「需要有有效的观看会话」
 *   ② GET  /api/danmaku/stream/<liveId>?source=member&room_id=&clientId=<同一个 uuid>
 *        → text/event-stream
 *
 * SSE 事件里 `msgType === 'PRESENT_NORMAL'` 就是送礼，`remoteExtension.giftInfo`
 * 带 giftId / giftName / giftNum / acceptUser.userId（⚠️ 有成员 uid，比 LRC 反解可靠）。
 * `speakerUserId` 是送礼人 uid。`serverTime` 是毫秒时间戳。
 *
 * ── 字段口径：必须和 backfill-live-gift.mjs 的 LRC 记录**完全同构** ─────────
 *   t   = 毫秒时间戳（这边用 serverTime）
 *   mid = 收礼成员 uid（LRC 侧是昵称反解，这边是 acceptUser.userId）
 *   sid = 0（LRC 侧固定 0；喂别的不但没意义，还会让 worker 的去重键对不上）
 *   sn  = 送礼人昵称
 *   gid = ''（LRC 侧拿不到 giftId 所以是空串；这边也留空，理由同上）
 *   num = 礼物个数
 *   src = 1（直播侧）
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   cd all48-live-sync && set -a && source nim-sync.env && set +a
 *   node live-sse-sync.mjs                     # 常驻
 *   DRY=1 RUN_MINUTES=2 node live-sse-sync.mjs # 只打印不上报
 *   RUN_MINUTES=330 node live-sse-sync.mjs     # 跑 5.5 小时后自己退出（Actions 用）
 */
import http from 'node:http';
import fs from 'node:fs';

const F48 = process.env.F48_BASE || 'https://48fan.com';
const UA = process.env.F48_UA
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.INGEST_TOKEN || '';

const GIFT_NAME = process.env.GIFT_NAME || '弦月回响';
const GIFT_IDS = (process.env.GIFT_IDS || '1320115721784332288,1320115721784332300')
  .split(',').map((s) => s.trim()).filter(Boolean);

const DRY = !!process.env.DRY;
const RUN_MINUTES = Math.max(0, Number(process.env.RUN_MINUTES || 0));
const RESCAN_MS = Math.max(20000, Number(process.env.RESCAN_MS || 60000));
const FLUSH_MS = Math.max(5000, Number(process.env.FLUSH_MS || 15000));
const MAX_ROOMS = Math.max(0, Number(process.env.MAX_ROOMS || 0));
const CONC = Math.max(1, Number(process.env.CONC || 2));       // 同时建连数（对 48fan 要客气）
const GAP_MS = Math.max(0, Number(process.env.GAP_MS || 8000)); // 两次 start 之间的间隔
// 🔴 48fan 的 /start 有「**突发**」限流（不是并发数、也不是每分钟配额）：
//    2026-10-25 实测 10 秒内连发 5 个必吃 429，而间隔 3~8 秒逐个来则一路 200。
//    会话建好后 /start 返回 reused:true，**完全不计数**，所以冷启动铺开后就不吃配额了。
const START_PER_MIN = Math.max(1, Number(process.env.START_PER_MIN || 12));

// 🔴🔴 硬限制：**同一个出口 IP 最多只能同时挂 ~6 条弹幕流**（2026-10-25 实测）。
//    第 7 条 start 直接 429，冷却多久都没用；而**已经建过会话的房间重连（reused）不吃配额**。
//    ⇒ 想覆盖更多直播间只能靠「多出口分片」：每个实例负责 liveId % SHARDS == SHARD 的那一片，
//      每片控制在 6 个以内。GitHub Actions 的每个 job 是独立 runner（独立 IP），天然可以分摊。
const SHARDS = Math.max(1, Number(process.env.SHARDS || 1));
const SHARD = Math.min(SHARDS - 1, Math.max(0, Number(process.env.SHARD || 0)));
// 🔴 别用 `Number(liveId) % SHARDS`：口袋48 的 liveId **末位永远是偶数**
//    （1320895340900847616 / 1320889448901971968 …），%10 只会落在 0/2/4/6/8，
//    10 片里有 5 片一个房间都分不到。必须走字符串哈希。
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const inShard = (liveId) => SHARDS === 1 || (fnv1a(String(liveId)) % SHARDS) === SHARD;
const PORT = Number(process.env.HEALTHZ_PORT || 8790);
const STATE_FILE = process.env.SSE_STATE || '/tmp/live-sse-sync.state.json';

const BJ = 8 * 3600 * 1000;
const since = Date.now();
const say = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(11, 19), ...a);

/* ───────────────────────────── 运行时状态 ───────────────────────────── */
const rooms = new Map();  // liveId -> { liveId, nick, clientId, abort, state, nMsg, nGift, lastEvAt, tries, nextTryAt, coveredFrom }
const seenMsg = new Set(); // msgId 去重（内存，滚动清）
let pending = [];          // 待上报
const covered = new Map(); // liveId -> 首次建连成功的时间（给 LRC 补抓判断要不要跳过）

let stopped = false;
let lastScanAt = 0;
let scanBusy = false;
let connecting = false;    // 同一时刻只建一条连接（串行）
let lastConnTickAt = 0;
let backoffUntil = 0;      // 被 429 后的全局冷却

/* 令牌桶：每分钟最多 START_PER_MIN 次 /start（48fan 的限流口径） */
const bucket = { tokens: START_PER_MIN, at: Date.now() };
function takeToken() {
  const now = Date.now();
  const refill = Math.floor((now - bucket.at) / 60000) * START_PER_MIN;
  if (refill > 0) { bucket.tokens = Math.min(START_PER_MIN, bucket.tokens + refill); bucket.at = now; }
  if (bucket.tokens <= 0) return false;
  bucket.tokens--;
  return true;
}

const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
});

function bjDay(ts) {
  return new Date(Number(ts) + BJ).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 48fan 的 '2026-10-24 23:26'（北京时间，分钟精度）→ 毫秒时间戳；解析不出来返回 0 */
function parseBj(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - BJ;
}

/* ─────────────────────────── 48fan 接口 ─────────────────────────────── */
async function f48Json(path, timeout = 25000) {
  const r = await fetch(F48 + path, {
    headers: { 'user-agent': UA, accept: 'application/json', referer: F48 + '/' },
    signal: AbortSignal.timeout(timeout),
  });
  const txt = await r.text();
  if (r.status === 429) { backoffUntil = Date.now() + 90000; throw new Error('429 限流'); }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${txt.slice(0, 80)}`);
  try { return JSON.parse(txt); } catch { throw new Error('不是 JSON: ' + txt.slice(0, 80)); }
}

/** 在播列表：48fan 自己认可的 68~75 场（🔴 不带 UA 会返回空数组，它按 UA 过滤） */
async function fetchLives() {
    const d = await f48Json('/api/member-lives');
    return (d.lives || []).map((x) => ({
      liveId: String(x.liveId),
      nick: String(x.nickname || ''),
      status: x.statusText || '',
      online: Number(x.onlineNum) || 0,
      // startTime 是北京时间 'YYYY-MM-DD HH:mm'（分钟精度）。
      // 🔴 只对「我们从开播就在看」的场次登记 covered，否则 LRC 补抓会跳过 ⇒ 前面那段永久漏分。
      startMs: parseBj(x.startTime),
    })).filter((x) => x.liveId && inShard(x.liveId));
}

/** 建立观看会话（拿到会话后才能开 SSE） */
async function startSession(liveId, clientId) {
  const r = await fetch(`${F48}/api/live-hls/member/${liveId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: F48, referer: F48 + '/' },
    body: JSON.stringify({ clientId }),
    signal: AbortSignal.timeout(25000),
  });
  const txt = await r.text();
  if (r.status === 429) { backoffUntil = Date.now() + 90000; return { ok: false, code: 429 }; }
  return { ok: r.ok && /"ok":true/.test(txt), code: r.status, txt: txt.slice(0, 120), reused: /"reused":true/.test(txt) };
}

/* ─────────────────────────── 房间生命周期 ───────────────────────────── */
function roomStat() {
  let live = 0, dead = 0;
  for (const r of rooms.values()) { if (r.state === 'live') live++; else dead++; }
  return { total: rooms.size, live, dead };
}

async function attach(room) {
  if (stopped || room.state === 'connecting' || room.state === 'live') return;
  if (Date.now() < backoffUntil) { room.state = 'wait'; room.nextTryAt = backoffUntil; return; }
  if (Date.now() < (room.nextTryAt || 0)) return;

  // 🔴 48fan 对 /start 限流很严（实测连 6 个就 429），但**同一个 clientId 的会话还在时
  //    直接开 SSE 是通的**。所以已经建过会话的房间重连时先试「不 start 直接连」，
  //    省下的配额留给真正需要新建会话的房间。
  if (room.sessionOk && room.clientId) {
    room.state = 'connecting';
    try {
      await consume(room, room.clientId);
      return;
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (!/sse (401|403)/.test(msg)) { onStreamEnd(room, e); return; }
      room.sessionOk = false;   // 会话真没了，下面走 start
    }
  }

  if (!takeToken()) { room.state = 'wait'; return; }   // 本分钟额度用完，下一轮继续，别硬撞出 429

  room.state = 'connecting';
  room.tries = (room.tries || 0) + 1;
  const clientId = room.clientId || (room.clientId = uuid());

  try {
    const s = await startSession(room.liveId, clientId);
    if (!s.ok) throw new Error(`start ${s.code}`);
    // reused=true 说明会话本来就在，48fan 不把它当新建 ⇒ 把令牌退回来
    if (s.reused) bucket.tokens = Math.min(START_PER_MIN, bucket.tokens + 1);
    room.sessionOk = true;
    // 只有「开播后 5 分钟内就连上」才算从头覆盖，才敢让 LRC 补抓跳过这场
    if (!covered.has(room.liveId) && room.coverable) covered.set(room.liveId, Date.now());
    // 🔴 千万别 await consume()：SSE 会挂几个小时，await 住的话后面所有房间永远连不上（第一版就这么写的）。
    consume(room, clientId).catch((e) => onStreamEnd(room, e));
  } catch (e) {
    onStreamEnd(room, e);
  }
}

/** 一条 SSE 流结束（正常断开 / 报错）后的退避重连 */
function onStreamEnd(room, e) {
  room.state = 'dead';
  room.abort = null;

  // 到了 185 秒我们主动断的 → 立刻重连（不惩罚、不消耗 /start 配额）
  if (room.softReconnect) {
    room.softReconnect = false;
    room.state = 'wait';
    room.nextTryAt = 0;
    return;
  }

  const msg = String((e && e.message) || e || '流结束').slice(0, 80);
  const is429 = /429/.test(msg);
  // 404 = 48fan 自己没在抓这个房间（不是我们的错），退避久一点别硬撞
  const wait = is429 ? 30000
    : /404/.test(msg) ? 300000
    : Math.min(120000, 3000 * Math.pow(1.8, Math.min(room.tries || 1, 6)));
  if (is429) { backoffUntil = Date.now() + 30000; say(`  ⏸ 触发 429，全局冷却 30 秒`); }
  room.nextTryAt = Date.now() + wait;
  if (!is429 && ((room.tries || 0) <= 2 || (room.tries || 0) % 10 === 0)) {
    say(`  ✗ ${room.nick || room.liveId} ${msg}（第 ${room.tries || 0} 次，${Math.round(wait / 1000)}s 后再试）`);
  }
}

async function consume(room, clientId) {
  const ctrl = new AbortController();
  room.abort = ctrl;
  room.softReconnect = false;
  // 🔴 48fan 的 SSE 到 ~220 秒必被对端关闭（实测 220s / 222s，非常准）。
  //    主动在 185 秒断开重连，比等它踢更快，重连走「不 start 直接连」也不吃配额。
  const soft = setTimeout(() => {
    room.softReconnect = true;
    try { ctrl.abort(); } catch {}
  }, Math.max(30000, Number(process.env.SSE_MAX_MS || 185000)));

  const url = `${F48}/api/danmaku/stream/${room.liveId}?source=member&room_id=&clientId=${clientId}`;
  const res = await fetch(url, {
    headers: { accept: 'text/event-stream', 'user-agent': UA, referer: F48 + '/' },
    signal: ctrl.signal,
  });
  if (!res.ok) {
    clearTimeout(soft);
    const t = await res.text().catch(() => '');
    throw new Error(`sse ${res.status} ${t.slice(0, 60)}`);
  }
  room.state = 'live';
  room.nextTryAt = 0;
  room.tries = 0;
  room.lastEvAt = Date.now();
  say(`  ● ${room.nick || room.liveId} 已连上（房间 ${rooms.size} 个，在线 ${roomStat().live}）`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        room.lastEvAt = Date.now();
        if (ev.type === 'message') handleMessage(room, ev);
      }
    }
    throw new Error('流被对端关闭');
  } finally {
    clearTimeout(soft);
    if (room.state === 'live') room.state = 'dead';
    room.abort = null;
  }
}

/* ─────────────────────────── 消息解析 ───────────────────────────────── */
function handleMessage(room, m) {
  const mt = String(m.msgType || '');
  if (mt !== 'PRESENT_NORMAL') return;             // 只要送礼（PRESENT_NORMAL）
  room.nMsg++;

  let ext = {};
  try { ext = JSON.parse(m.remoteExtension || '{}'); } catch { return; }
  const gi = ext.giftInfo;
  if (!gi) return;

  const gname = String(gi.giftName || '');
  const gid = String(gi.giftId || '');
  const hit = (GIFT_NAME && gname.includes(GIFT_NAME)) || (gid && GIFT_IDS.includes(gid));
  if (!hit) return;

  const acc = gi.acceptUser || {};
  const mid = Number(acc.userId) || 0;
  if (!mid) return;                                 // 连收礼人都不知道，没法归户，宁可不记

  const msgId = String(m.msgId || '');
  if (msgId) {
    if (seenMsg.has(msgId)) return;
    seenMsg.add(msgId);
    if (seenMsg.size > 20000) seenMsg.clear();
  }

  const t = Number(m.serverTime) || Math.round(Number(m.ts) * 1000) || Date.now();
  const num = Math.max(1, Math.floor(Number(gi.giftNum) || 1));
  const sn = String(m.sender || m.senderName || '').slice(0, 40);

  // 🔴 g 必须带（worker 的 isTargetGift 靠「礼物名包含」或「giftId 在白名单」判定，
  //    两个都不给就被当非目标礼物 drop，日志里只会看到 kept=0 —— 2026-10-25 踩过这个坑）。
  // gid 仍留空，跟 LRC 侧保持同构。
  const rec = { t, mid, sid: 0, sn, gid: '', g: gname, num, src: 1 };
  room.nGift++;
  pending.push(rec);
  say(`  🎁 ${String(acc.starName || acc.userName || mid).padEnd(10)} ${num} 个 ${gname} ← ${sn}  [${room.nick}]`);
}

/* ─────────────────────────── 上报 ───────────────────────────────────── */
async function flush() {
  if (!pending.length) return;
  const items = pending;
  pending = [];
  if (DRY || !SITE) { say(`  (DRY) 待上报 ${items.length} 条：${JSON.stringify(items.slice(0, 3))}`); return; }
  try {
    const r = await fetch(`${SITE}/api/gift/ingest`, {
      method: 'POST',
      // 🔴 必须带 UA：worker 在 Cloudflare 上，Bot Fight 会拦「无 UA 的 POST」直接回 405
      headers: { 'content-type': 'application/json', 'x-ingest-token': TOKEN, 'user-agent': 'all48-live-sse/1.0' },
      body: JSON.stringify({ items, ch: 'sse' }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json().catch(() => ({}));
    say(`  ⬆ 上报 ${items.length} 条 → kept=${d.kept ?? '?'} added=${d.added ?? '?'}${d.error ? ' err=' + d.error : ''}`);
  } catch (e) {
    say(`  ⚠️ 上报失败（${String(e.message).slice(0, 60)}），${items.length} 条塞回去下次重试`);
    pending = items.concat(pending).slice(-3000);
  }
}

/** 告诉站里「这些场次我实时盯着了」，让 LRC 补抓别再重复扫 */
let coveredSent = new Map();
async function flushCovered() {
  if (DRY || !SITE) return;
  const add = {};
  for (const [k, v] of covered) if (coveredSent.get(k) !== v) add[k] = v;
  if (!Object.keys(add).length) return;
  try {
    const r = await fetch(`${SITE}/api/gift/covered`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': TOKEN, 'user-agent': 'all48-live-sse/1.0' },
      body: JSON.stringify({ lives: add }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) { for (const k of Object.keys(add)) coveredSent.set(k, add[k]); }
  } catch { /* 下次再试 */ }
}

/* ─────────────────────────── 扫在播 ─────────────────────────────────── */
async function scan() {
  if (scanBusy || stopped) return;
  if (Date.now() < backoffUntil) return;
  scanBusy = true;
  try {
    const lives = await fetchLives();
    if (!lives.length) { say('⚠️ 在播列表为空（48fan 可能挂了或限流）'); return; }
    const want = new Map(lives.map((x) => [x.liveId, x]));

    // 下播的关掉
    for (const [id, room] of rooms) {
      if (!want.has(id)) {
        try { room.abort?.abort(); } catch {}
        rooms.delete(id);
        say(`  ○ ${room.nick || id} 下播（收 ${room.nGift} 个）`);
      }
    }
    // 新开播的加进来
    let added = 0;
    for (const x of lives) {
      if (rooms.has(x.liveId)) continue;
      if (MAX_ROOMS && rooms.size >= MAX_ROOMS) break;
      rooms.set(x.liveId, {
        liveId: x.liveId, nick: x.nick, clientId: uuid(), abort: null,
        state: 'wait', nMsg: 0, nGift: 0, lastEvAt: 0, tries: 0, nextTryAt: 0,
        sessionOk: false, softReconnect: false,
        // 我们是不是从小就在看：开播不到 5 分钟（或拿不到开播时间就保守认为不是）
        coverable: !!x.startMs && (Date.now() - x.startMs) <= 5 * 60000,
      });
      added++;
    }
    if (added) say(`新开播 ${added} 个 → 待连 ${roomStat().dead} / 已连 ${roomStat().live}`);
    const st = roomStat();
    say(`📡 在播 ${lives.length} | 已连 ${st.live} | 待连 ${st.dead} | 累计礼物 ${[...rooms.values()].reduce((a, r) => a + r.nGift, 0)} | 待上报 ${pending.length}`);
    lastScanAt = Date.now();
  } catch (e) {
    say(`⚠️ 扫在播失败：${String(e.message).slice(0, 90)}`);
  } finally {
    scanBusy = false;
  }
}

/**
 * 建连节拍：每 GAP_MS 只连一个房间。
 * 🔴 别把建连塞进 scan() 里（第一版就是那样）：scan 一轮要等 60 秒才跑下一次，
 *    62 个房间得等十几分钟才铺开，中间还有流断掉要重连，永远追不上。
 */
async function connectTick() {
  if (stopped || connecting) return;
  if (Date.now() < backoffUntil) return;
  if (Date.now() - lastConnTickAt < GAP_MS) return;
  for (const room of rooms.values()) {
    if (room.state !== 'wait' && room.state !== 'dead') continue;
    if (Date.now() < (room.nextTryAt || 0)) continue;
    if (bucket.tokens <= 0) return;          // 本分钟额度用完，等补充
    connecting = true;
    lastConnTickAt = Date.now();
    try { await attach(room); } finally { connecting = false; }
    return;
  }
}

/* ─────────────────────────── 健康检查 ───────────────────────────────── */
const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/') {
    const st = roomStat();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: !stopped,
      shard: SHARDS === 1 ? 'all' : `${SHARD}/${SHARDS}`,
      uptimeSec: Math.round((Date.now() - since) / 1000),
      rooms: st,
      gifts: [...rooms.values()].reduce((a, r) => a + r.nGift, 0),
      pending: pending.length,
      backoffMs: Math.max(0, backoffUntil - Date.now()),
      lastScanAt,
      covered: covered.size,
      detail: [...rooms.values()].map((r) => ({ nick: r.nick, liveId: r.liveId, state: r.state, gift: r.nGift, msg: r.nMsg })),
    }, null, 1));
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, '127.0.0.1', () => say(`healthz http://127.0.0.1:${PORT}/healthz`));

/* ─────────────────────────── 主循环 ─────────────────────────────────── */
say(`启动：48fan=${F48} | 目标礼物「${GIFT_NAME}」 ids=${GIFT_IDS.join(',')} | ${DRY ? 'DRY 不上报' : '上报到 ' + SITE} | RUN ${RUN_MINUTES || '∞'} 分钟 | CONC ${CONC} GAP ${GAP_MS}ms | 分片 ${SHARD}/${SHARDS}`);

const timers = [];
timers.push(setInterval(() => { scan(); }, RESCAN_MS));
timers.push(setInterval(() => { connectTick(); }, 1000));
timers.push(setInterval(() => { flush(); }, FLUSH_MS));
timers.push(setInterval(() => { flushCovered(); }, 60000));

// 僵死连接巡检：60 秒没有任何事件（连 online_update 都没有）就重连
timers.push(setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state === 'live' && room.lastEvAt && now - room.lastEvAt > 5 * 60000) {
      say(`  ⟳ ${room.nick || room.liveId} 5 分钟没事件，重连`);
      try { room.abort?.abort(); } catch {}
      room.state = 'dead';
      room.nextTryAt = 0;
    }
  }
}, 60000));

async function shutdown(why) {
  if (stopped) return;
  stopped = true;
  say(`收尾（${why}）：断所有流 + 最后上报`);
  for (const t of timers) clearInterval(t);
  for (const room of rooms.values()) { try { room.abort?.abort(); } catch {} }
  await flush();
  await flushCovered();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      at: Date.now(),
      covered: Object.fromEntries(covered),
      rooms: [...rooms.values()].map((r) => ({ liveId: r.liveId, nick: r.nick, gift: r.nGift })),
    }, null, 1));
  } catch {}
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => say('❗ uncaught', String(e && e.message).slice(0, 120)));
process.on('unhandledRejection', (e) => say('❗ unhandled', String(e && e.message).slice(0, 120)));

if (RUN_MINUTES) setTimeout(() => shutdown(`到点 ${RUN_MINUTES} 分钟`), RUN_MINUTES * 60 * 1000);

await scan();
