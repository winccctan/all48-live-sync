/**
 * 房间侧「弦月回响」深度回填
 * =====================================================================
 * 为什么需要：gift-sync（每 2 分钟一轮）只从游标往前走、每轮翻几页，
 *   成员换过 channelId（左婧媛 1164995→1312222、杨宝君 39014945→39031753）
 *   或者某段时间房间刷得太快，游标之后那段就永久漏了。
 *   gnz 那边对每个房间做 backfill（activeRoomsBackfilled），所以它的房间分更全。
 *
 * 本脚本对指定成员**从最新一路往回翻到活动起点**，把漏掉的弦月回响全部补上报。
 * 🔴 不改游标（gift:cursor），避免和 gift-sync 抢进度。
 *
 * 用法：
 *   UIDS=327577 node room-backfill.mjs                  # 指定一个人
 *   UIDS=327577,175308891 CONC=3 node room-backfill.mjs  # 多人
 *   NAMES=左婧媛,杨宝君 node room-backfill.mjs           # 按名字
 *   DRY=1 node room-backfill.mjs                         # 只看不写
 *
 * 环境变量：SITE_URL / INGEST_TOKEN / POCKET48_TOKEN
 */
import { fetchMessagePage } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const BJ = 8 * 3600e3;
const SINCE = Number(process.env.SINCE_MS) || (Date.UTC(2026, 9, 24, 0, 0, 0) - BJ);  // 北京 10-24 00:00
const MAX_PAGES = Math.max(1, Number(process.env.MAX_PAGES || 300));
const CONC = Math.max(1, Number(process.env.CONC || 2));
const DRY = !!process.env.DRY;
const TARGET = String(process.env.GIFT_NAME || '弦月回响').trim();

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SITE || !TOKEN) { console.error('缺 SITE_URL / POCKET48_TOKEN'); process.exit(1); }

/* ------------------------------------------------------------- 成员目录 */
const txt = await (await fetch(SITE + '/data/members.js')).text();
const all = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const byUid = new Map(all.map((m) => [Number(m.id), m]));
const byName = new Map(all.map((m) => [String(m.n).trim(), m]));

let members = [];
if (process.env.UIDS) {
  members = String(process.env.UIDS).split(',').map((s) => byUid.get(Number(s.trim()))).filter(Boolean);
} else if (process.env.NAMES) {
  members = String(process.env.NAMES).split(',').map((s) => byName.get(s.trim())).filter(Boolean);
}
if (!members.length) { console.error('没指定成员（UIDS= 或 NAMES=）'); process.exit(1); }
log(`目标成员 ${members.length} 人，起点 ${new Date(SINCE + BJ).toISOString().slice(0, 16)}（北京）`);

/* --------------------------------------------------- 单条消息 → 礼物 */
let CFG_IDS = new Set();
try {
  const j = await (await fetch(SITE + '/api/gift/cursor', { headers: { 'x-ingest-token': INGEST } })).json();
  if (j && j.cfg && Array.isArray(j.cfg.ids)) CFG_IDS = new Set(j.cfg.ids.map(String));
  if (j && j.cfg && j.cfg.name) { /* 名字以 TARGET 为准 */ }
} catch { /* noop */ }

function isTarget(gid, gname) {
  const n = String(gname || '').trim();
  if (n && n.indexOf(TARGET) >= 0) return true;
  return CFG_IDS.has(String(gid || ''));
}

function parseGift(m, member) {
  let ext = {};
  try { ext = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : (m.extInfo || {}); } catch { ext = {}; }
  const u = ext.user || {};
  const sid = Number(u.userId) || 0;
  const sn = String(u.nickname || u.nickName || '');
  const t = Number(m.msgTime) || 0;
  if (!sid || !t) return null;
  let ct = {};
  try { ct = typeof m.bodys === 'string' ? JSON.parse(m.bodys) : (m.bodys || {}); } catch { return null; }
  const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
  if (!gi) return null;
  const gname = String(gi.giftName || '');
  const gid = String(gi.giftId || '');
  if (!isTarget(gid, gname)) return null;
  return { t, mid: Number(member.id), sid, sn, g: gname || TARGET, gid, num: Math.max(1, Math.floor(Number(gi.giftNum) || 1)), src: 0 };
}

/* --------------------------------------------------------- 单人深度翻页 */
async function backfillOne(member) {
  let next = 0;
  let pages = 0, msgs = 0, hits = 0, items = [];
  let reached = false;
  while (pages < MAX_PAGES) {
    let r;
    try {
      r = await fetchMessagePage({
        serverId: member.srv, channelId: member.ch,
        nextTime: next, limit: 50, token: TOKEN, scope: 'all',
      });
    } catch (e) {
      log(`  [${member.n}] 第 ${pages + 1} 页失败：${String(e.message).slice(0, 60)}`);
      break;
    }
    const list = (r && r.messages) || [];
    if (!list.length) { reached = true; break; }
    pages++;
    msgs += list.length;
    let oldest = Infinity;
    for (const m of list) {
      const t = Number(m.msgTime) || 0;
      if (t && t < oldest) oldest = t;
      if (t && t < SINCE) { reached = true; continue; }
      const g = parseGift(m, member);
      if (g) { items.push(g); hits += g.num; }
    }
    if (reached) break;
    const nx = r.nextTime;
    if (!nx || String(nx) === '0' || String(nx) === String(next)) break;
    next = nx;
    await sleep(150);
  }
  log(`  [${member.n}] 翻 ${pages} 页 ${msgs} 条 → 弦月回响 ${items.length} 次 / ${hits} 个${reached ? '' : '（未到起点，受 MAX_PAGES 限制）'}`);
  return items;
}

/* ------------------------------------------------------------------ 上报 */
async function ingest(items) {
  if (!items.length) return;
  if (DRY) { log(`  [DRY] 本应上报 ${items.length} 条`); return; }
  const BATCH = 1500;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const res = await fetch(SITE + '/api/gift/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify({ items: chunk, ch: 'im', stats: { '房间回填': chunk.length } }),
    });
    const out = await res.json().catch(() => ({}));
    log(`  ↑ 上报 ${chunk.length} → kept=${out.kept} added=${out.added}`);
  }
}

/* ------------------------------------------------------------------ 主流程 */
const t0 = Date.now();
const results = [];
let idx = 0;
async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= members.length) return;
    const m = members[i];
    if (!m.srv || !m.ch) { log(`  [${m.n}] 无 srv/ch，跳过`); continue; }
    const items = await backfillOne(m);
    results.push({ n: m.n, items });
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, members.length) }, worker));

const allItems = results.flatMap((r) => r.items);
await ingest(allItems);

log(`完成：${results.length} 人 · ${allItems.length} 次 / ${allItems.reduce((a, b) => a + b.num, 0)} 个 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const r of results.sort((a, b) => b.items.length - a.items.length)) {
  if (r.items.length) log(`  ${r.n}: ${r.items.reduce((a, b) => a + b.num, 0)} 个`);
}
