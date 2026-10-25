#!/usr/bin/env node
/**
 * perf-gift-sync.mjs —— 公演直播间礼物采集（**自己算鸡腿**，不依赖任何第三方统计接口）
 *
 * ── 为什么这么做 ───────────────────────────────────────────────────────
 * 公演直播间的礼物不进成员房间 IM，口袋48 的公演聊天室（roomId 3869841 等）又拿不到
 * srv/ch（im/server/jump 对 roomId / liveId 任何 targetType 都回「目标不存在」），
 * 公演回放也没有弹幕文件（getOpenLiveOne 只给 perform-vod 的 m3u8，没有 msgFilePath）。
 * ⇒ 只有一条路：**公演开演时盯着它的弹幕流，把礼物当场记下来**。
 *    弹幕流沿用项目里已经在用的那套 relay（和成员直播同一个通道），
 *    但**礼物名、数量、收礼人、单价、鸡腿全部由我们自己按价目表算**，
 *    不读任何别人算好的榜、不拼别人的口径。
 *
 * 落库：POST {SITE}/api/lv/all  { ch:'perf', items:[{t,mid,sid,sn,g,num,v,room:3}] }
 *       POST {SITE}/api/perf/sessions { sessions:[…] }   ← 场次/队伍/标题/点赞
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   cd all48-live-sync && set -a && source nim-sync.env && set +a
 *   RUN_MINUTES=180 node perf-gift-sync.mjs        # Actions：跑 3 小时后自己退出
 *   DRY=1 RUN_MINUTES=2 node perf-gift-sync.mjs    # 只打印不上报
 */
import { postJson } from './lib/api.mjs';
import { priceOf } from './lib/gift-price.mjs';

const F48 = process.env.F48_BASE || 'https://48fan.com';
const UA = process.env.F48_UA
  || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.INGEST_TOKEN || '';
const DRY = !!process.env.DRY;
const RUN_MINUTES = Math.max(1, Number(process.env.RUN_MINUTES || 180));
const RESCAN_MS = Math.max(30000, Number(process.env.RESCAN_MS || 120000));
// 🔴 实时：站长拿它当比赛依据，20 秒一批太慢 ⇒ 6 秒就推（单条请求量很小，ingest 是 KV+R2 读改写，别低于 5 秒）
const FLUSH_MS = Math.max(3000, Number(process.env.FLUSH_MS || 6000));
const SSE_MAX_MS = Math.max(30000, Number(process.env.SSE_MAX_MS || 185000));
// 🔴 默认值从 4 提到 6（2026-10-25 事故）：13:45 四剧场同时开演时，13:15 就开演的场次
//    会被「最新开演优先 + 截断」挤掉，整场一条礼物都收不到（肆时墟就是这样丢掉 1915 鸡腿）。
//    48fan 单出口 IP 大约能开 6 条并发流，所以 6 是上限，再多会 429。
const MAX_ROOMS = Math.max(1, Number(process.env.MAX_ROOMS || 6));

/* ───────────────────── 分片（多出口） ─────────────────────
 * 🔴 站长 2026-10-25：「同时段可能 10 场公演的」。
 *    48fan 单出口 IP 大约只能开 6 条并发流（第 7 条 429，冷却也没用），
 *    一个 job 单 IP 无论如何都盖不住 10 场 ⇒ 必须像 live-sse-sync 那样按
 *    「多出口分片」：每个 job 是独立 runner（独立 IP），只负责自己那一片。
 * 🔴 别用 `Number(id) % SHARDS`：公演 liveId 末位基本是偶数，取模只会落在一半分片上。 */
const SHARDS = Math.max(1, Number(process.env.SHARDS || 1));
/* 🔴 副本（2026-10-25 站长：「公演鸡腿必须实时，要作为比赛依据」）
 *    公演礼物**没有回放、没有 IM 可补**（probe 已验），流上丢一条就永久少一分。
 *    所以每片派两个独立 runner（独立出口 IP）同时听同一批场次，
 *    两路各自落库、按 t|mid|g|num|room 精确去重 ⇒ 一路断流/丢消息，另一路兜住。
 *    matrix 里 SHARD 取 0..SHARDS*REPLICAS-1，数据片 = SHARD % SHARDS。 */
const REPLICAS = Math.max(1, Number(process.env.REPLICAS || 1));
const TOTAL_SHARDS = SHARDS * REPLICAS;
const SHARD = Math.min(TOTAL_SHARDS - 1, Math.max(0, Number(process.env.SHARD || 0)));
const MY_SHARD = SHARD % SHARDS;
const REPLICA = Math.floor(SHARD / SHARDS);
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const inShard = (id) => SHARDS === 1 || (fnv1a(String(id)) % SHARDS) === MY_SHARD;

const GROUPS = [
  { id: 10, name: 'SNH48' }, { id: 11, name: 'BEJ48' }, { id: 12, name: 'GNZ48' },
  { id: 14, name: 'CKG48' }, { id: 21, name: 'CGT48' },
];

const BJ = 8 * 3600e3;
const bj = (t) => (t ? new Date(t + BJ).toISOString().replace('T', ' ').slice(5, 16) : '-');
const say = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(11, 19), ...a);
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = (Math.random() * 16) | 0;
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
});

/* ───────────────────────── 场次（口袋48 官方排期） ───────────────────────── */
async function page(groupId, next, record) {
  const j = await postJson('/live/api/v1/live/getOpenLiveList', {
    debug: false, groupId, next: Number(next) || 0, record: !!record,
  }, { retries: 2 });
  const c = j?.content || {};
  return { list: Array.isArray(c.liveList) ? c.liveList : [], next: c.next ?? 0 };
}

async function listSessions() {
  const out = [];
  const seen = new Set();
  for (const g of GROUPS) {
    for (const record of [false, true]) {
      try {
        const { list } = await page(g.id, 0, record);
        for (const it of list) {
          const id = String(it.liveId || '');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            g: g.name,
            team: (it.teamList || []).map((t) => t.teamName).filter(Boolean).join(' / '),
            title: String(it.title || ''),
            sub: String(it.subTitle || ''),
            st: Number(it.stime) || 0,
            et: Number(it.endTime) || 0,
            status: Number(it.status) || 0,     // 1 未开播 / 2 直播中 / 4 已结束
            praise: 0,
          });
        }
      } catch (e) {
        say(`[${g.name}] 排期拉取失败（${record ? '归档' : '预告'}）：${String(e.message).slice(0, 60)}`);
      }
    }
  }
  return out;
}

async function pushSessions(list) {
  if (DRY || !SITE || !list.length) return;
  try {
    const r = await fetch(`${SITE}/api/perf/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': TOKEN, 'user-agent': 'all48-perf-gift/1.0' },
      body: JSON.stringify({ sessions: list }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json().catch(() => ({}));
    say(`⬆ 场次 ${list.length} 场 → added=${d.added ?? '?'} total=${d.total ?? '?'}`);
  } catch (e) {
    say(`⚠️ 场次上报失败：${String(e.message).slice(0, 60)}`);
  }
}

/** 在播判定：status=2 直接算；status 有延迟，所以「到点了又没标结束」也先连上 */
function isLive(s, now) {
  if (s.status === 4) return false;
  if (s.status === 2) return true;
  if (!s.st) return false;
  return s.st - 10 * 60e3 <= now && now < s.st + 6 * 3600e3;
}

/* ───────────────────────── 弹幕流 ───────────────────────── */
const rooms = new Map();     // liveId → { …session, clientId, state, tries, nextTryAt }
let pending = [];
let seq = 0;
const seenMsg = new Set();

async function startSession(liveId, clientId) {
  const r = await fetch(`${F48}/api/live-hls/performance/${liveId}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, origin: F48, referer: F48 + '/' },
    body: JSON.stringify({ clientId }),
    signal: AbortSignal.timeout(25000),
  });
  const txt = await r.text();
  return { ok: r.ok && /"ok":true/.test(txt), code: r.status, txt: txt.slice(0, 120), reused: /"reused":true/.test(txt) };
}

function onGift(room, m) {
  if (String(m.msgType || '') !== 'PRESENT_NORMAL') return;
  let ext = {};
  try { ext = JSON.parse(m.remoteExtension || '{}'); } catch { return; }
  const gi = ext.giftInfo;
  if (!gi) return;
  const gname = String(gi.giftName || '');
  if (!gname) return;
  const acc = gi.acceptUser || {};
  const mid = Number(acc.userId) || 0;
  if (!mid) return;                       // 不知道送给谁就不记，绝不猜

  const msgId = String(m.msgId || '');
  if (msgId) { if (seenMsg.has(msgId)) return; seenMsg.add(msgId); if (seenMsg.size > 50000) seenMsg.clear(); }

  const t = Number(m.serverTime) || Math.round(Number(m.ts) * 1000) || Date.now();
  /* 🔴 数量字段：48fan 转发的是口袋48 原始消息，理论上 giftNum 就是数量。
     但公演侧 1160 条历史记录里 **没有一条 num>1**（直播侧同一字段一堆 2/3/5/10），
     说明要么公演礼物被拆条、要么字段名换了 ⇒ 多读几个候选名，宁可多算也不错算。 */
  const gnum = gi.giftNum != null ? gi.giftNum : (gi.giftCount != null ? gi.giftCount : gi.num);
  const num = Math.max(1, Math.floor(Number(gnum) || 1));
  const v = priceOf(String(gi.giftId || ''), gname);
  const rec = {
    // 🔴 sid = 公演直播间 id（= 场次 id）：这是「这条礼物属于哪一场」的唯一可靠证据。
    //    写 0 的话站点只能按成员名册的团去猜时间窗，兼任成员（如 GNZ48 的她上 SNH48 NII 公演）会归错队；
    //    13:45 这种四个剧场同时开演的时刻更是必错。
    // 🔴 必须是**字符串**：19 位 id 超过 Number.MAX_SAFE_INTEGER，转数字会末位失真，归场直接失效。
    t, mid, sid: String(room.id || ''), sn: String(m.sender || m.senderName || '').slice(0, 40),
    g: gname, num, v, room: 3,
  };
  pending.push(rec);
  room.n++;
  if (room.n <= 8 || room.n % 50 === 0) {
    say(`🎁 ${String(acc.starName || acc.userName || mid)} ${num} 个 ${gname}（${v}）← ${rec.sn}  [${room.g}]`);
  }
}

async function consume(room, clientId) {
  const ctrl = new AbortController();
  room.abort = ctrl;
  room.soft = false;
  const soft = setTimeout(() => { room.soft = true; try { ctrl.abort(); } catch {} }, SSE_MAX_MS);
  const url = `${F48}/api/danmaku/stream/${room.id}?source=performance&room_id=&clientId=${clientId}`;
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
  room.tries = 0;
  room.lastEv = Date.now();
  say(`● 已连上「${room.title.slice(0, 18)}」(${room.g})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      room.lastEv = Date.now();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (ev.type === 'message') onGift(room, ev);
      }
    }
    throw new Error('流被对端关闭');
  } finally {
    clearTimeout(soft);
    if (room.state === 'live') room.state = 'dead';
    room.abort = null;
  }
}

async function attach(room) {
  if (room.state === 'connecting' || room.state === 'live') return;
  if (Date.now() < (room.nextTryAt || 0)) return;
  room.state = 'connecting';
  room.tries = (room.tries || 0) + 1;
  const clientId = room.clientId || (room.clientId = uuid());
  try {
    if (room.sessionOk) {
      consume(room, clientId).catch((e) => onEnd(room, e));
      return;
    }
    const s = await startSession(room.id, clientId);
    if (!s.ok) throw new Error(`start ${s.code} ${s.txt}`);
    room.sessionOk = true;
    consume(room, clientId).catch((e) => onEnd(room, e));
  } catch (e) {
    onEnd(room, e);
  }
}

function onEnd(room, e) {
  room.state = 'dead';
  if (room.soft) { room.soft = false; room.nextTryAt = 0; return; }
  const msg = String((e && e.message) || e).slice(0, 80);
  const wait = /429/.test(msg) ? 45000 : /401|403/.test(msg) ? 120000 : Math.min(120000, 4000 * (room.tries || 1));
  if ((room.tries || 0) <= 3) say(`✗ ${room.g} ${room.title.slice(0, 12)} ${msg}（${Math.round(wait / 1000)}s 后重试）`);
  room.sessionOk = /sse (401|403)/.test(msg) ? false : room.sessionOk;
  room.nextTryAt = Date.now() + wait;
}

/* ───────────────────────── 上报 ───────────────────────── */
async function flush() {
  if (!pending.length) return;
  const items = pending;
  pending = [];
  if (DRY || !SITE) { say(`(DRY) ${items.length} 条：${JSON.stringify(items.slice(0, 2))}`); return; }
  const body = JSON.stringify({ ch: 'perf', items });
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${SITE}/api/lv/all`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-token': TOKEN, 'user-agent': 'all48-perf-gift/1.0' },
        body,
        signal: AbortSignal.timeout(25000),
      });
      const d = await r.json().catch(() => ({}));
      say(`⬆ 上报 ${items.length} 条 → ${JSON.stringify(d.days || d)}`);
      return;
    } catch (e) {
      if (i === 2) { pending = items.concat(pending).slice(-4000); say(`⚠️ 上报失败：${String(e.message).slice(0, 60)}`); }
      else await new Promise((s) => setTimeout(s, 4000));
    }
  }
}

/* ───────────────────────── 主循环 ───────────────────────── */
const started = Date.now();
let stopped = false;
process.on('SIGTERM', () => { stopped = true; });
process.on('SIGINT', () => { stopped = true; });

async function scan() {
  let list;
  try { list = await listSessions(); } catch (e) { say('排期失败：' + String(e.message).slice(0, 60)); return; }
  await pushSessions(list.filter((s) => s.st > Date.now() - 30 * 86400e3));

  const now = Date.now();
  const all = list.filter((s) => isLive(s, now) && inShard(s.id)).sort((a, b) => b.st - a.st);
  const live = all.slice(0, MAX_ROOMS);
  if (!live.length) { say(`当前没有在播的公演（片 ${MY_SHARD}/${SHARDS} 副本 ${REPLICA + 1}/${REPLICAS}，每分钟再看一次）`); return; }
  // 🔴 超上限时一定要吼出来：被挤掉的那场会一条礼物都收不到，静默截断最坑。
  if (all.length > live.length) {
    say(`⚠️ 本片在播 ${all.length} 场 > 上限 ${MAX_ROOMS}，未监听：` +
      all.slice(live.length).map((s) => `${s.g} ${(s.title || '').slice(0, 10)}`).join(' / '));
  }
  for (const s of live) {
    const old = rooms.get(s.id);
    if (old) { Object.assign(old, { title: s.title, team: s.team, status: s.status, et: s.et }); continue; }
    rooms.set(s.id, {
      ...s, clientId: uuid(), state: 'wait', tries: 0, nextTryAt: 0, n: 0, sessionOk: false,
    });
    say(`+ 加入监听：${s.g} ${s.team || ''} ${s.title.slice(0, 20)}（${bj(s.st)} 开演）`);
  }
  // 已经结束的场次收掉
  for (const [id, r] of rooms) {
    if (r.status === 4 || (r.et && now > r.et + 10 * 60e3)) {
      try { r.abort && r.abort.abort(); } catch {}
      rooms.delete(id);
      say(`- 收工：${r.g} ${r.title.slice(0, 16)}（共 ${r.n} 条礼物）`);
    }
  }
}

say(`公演礼物采集启动：最长 ${RUN_MINUTES} 分钟${DRY ? '（DRY）' : ''}，片 ${MY_SHARD}/${SHARDS} 副本 ${REPLICA + 1}/${REPLICAS}，上报间隔 ${FLUSH_MS / 1000}s`);
await scan();

const tick = setInterval(() => {
  for (const r of rooms.values()) attach(r);
}, 15000);
/* 🔴 假活看门狗（2026-10-25「为什么丢数据」）：流断了但 TCP 没报错时，
 *    读取端会一直挂着等，看起来在听、其实一条都收不到（半开连接）。
 *    公演聊天室弹幕很密（实测 200 秒 26 条），所以「120 秒一条事件都没有」= 死了，
 *    主动 soft 断开重连，别干等 SSE_MAX_MS。 */
const WATCH_MS = 120000;
const watchTimer = setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.state !== 'live' || !r.lastEv) continue;
    if (now - r.lastEv > WATCH_MS) {
      say(`⟳ ${r.g} ${r.title.slice(0, 12)} 静默 ${Math.round((now - r.lastEv) / 1000)}s，判为断流，重连`);
      r.lastEv = now;                     // 避免下一轮重复触发
      r.soft = true;                      // 当主动断开处理：不涨退避、立即重连
      try { r.abort && r.abort.abort(); } catch {}
    }
  }
}, 15000);
const flushTimer = setInterval(() => { flush(); }, FLUSH_MS);
const scanTimer = setInterval(() => { scan(); }, RESCAN_MS);
const doneTimer = setInterval(() => {
  if (stopped || Date.now() - started > RUN_MINUTES * 60e3) {
    clearInterval(tick); clearInterval(flushTimer); clearInterval(scanTimer); clearInterval(doneTimer); clearInterval(watchTimer);
    for (const r of rooms.values()) { try { r.abort && r.abort.abort(); } catch {} }
    flush().finally(() => {
      say(`结束。监听过的场次 ${rooms.size}，累计礼物 ${[...rooms.values()].reduce((a, b) => a + b.n, 0)} 条`);
      process.exit(0);
    });
  }
}, 5000);
