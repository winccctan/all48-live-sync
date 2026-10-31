/*
 * 直播侧礼物抓取：扫「已结束」的直播场次，从弹幕 LRC 里抽系统礼物播报。
 *
 * 为什么房间 IM 不够：
 *   口袋48 的**直播间送礼不进房间 IM**，它写进每场直播的弹幕文件：
 *     POST /live/api/v1/live/getLiveOne {liveId} -> content.msgFilePath   (LRC)
 *     LRC 行： [00:04:05.600]昵称<TAB>送给SNH48-某某 1个瓶装桂花
 *   这条链路在王语晨补档站已跑了很久（scripts/build-live-gifts.mjs）。
 *
 * 🔴 两个硬约束（2026-10-24 实测，别再猜）：
 *   ① 只有**已结束**的场次才有 msgFilePath；在播的场次该字段不存在（只有 danMuInfo），
 *      所以直播侧的计分天然滞后到「这场播完」，做不到秒级。
 *   ② 弹幕里**只有昵称、没有 uid**，归户只能靠「昵称 → uid」反查（站点侧用房间记录建索引）。
 *
 * 用法（GitHub Actions 里由 sync.yml 的 live-gift job 调）：
 *   node live-gift-sync.mjs
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN   站点与上报令牌（必填）
 *   POCKET48_TOKEN            口袋48 token（必填）
 *   SCRAPE_PROXY              国内代理（必填，海外 IP 一律 403）
 *   LG_MAX                    本轮最多扫几场（默认 25）
 *   LG_SINCE                  只扫这之后开的场（'YYYY-MM-DD'，默认今天往前 3 天）
 *   ALL=1                     🔴 额外把**每一款礼物**（不只是弦月回响）按价写成「鸡腿榜」数据：
 *                             本地 JSON（OUT）+ POST /api/lv/all → R2 lv:all:YYYYMMDD
 *                             room 记 2（成员直播侧），带 priceOf() 算出的单价与总额
 *   OUT                       配合 ALL=1，写一份本地 json（GitHub runner 上可当 artifact）
 */
import { postJson } from './lib/api.mjs';
import { priceOf } from './lib/gift-price.mjs';
import { writeFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || '').replace(/\/$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const MAX = Math.max(1, Number(process.env.LG_MAX || 25));

const log = (...a) => console.log(...a);
const t0 = Date.now();

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

function dayStr(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}
const SINCE_DAY = process.env.LG_SINCE || dayStr(Date.now() - 3 * 86400000);
const SINCE = Date.parse(SINCE_DAY + 'T00:00:00+08:00');
/* 回补历史时按「时间窗口」切片用：只扫 UNTIL 之前开的场（默认不限）。
   与 LG_SINCE 配对成一个月的窗口，多个 job 并行互不重叠。 */
const UNTIL_DAY = process.env.LG_UNTIL || '';
const UNTIL = UNTIL_DAY ? Date.parse(UNTIL_DAY + 'T00:00:00+08:00') + 86400000 : Infinity;

/* ---------- ① 站点配置 + 已扫场次 ---------- */
let cfg = { name: '弦月回响', ids: [] };
let lives = {};
try {
  const r = await fetch(SITE + '/api/gift/cursor', { headers: { 'x-ingest-token': INGEST } });
  const j = await r.json();
  if (j && j.cfg && j.cfg.name) cfg = j.cfg;
  lives = (j && j.lives) || {};
  log(`目标礼物「${cfg.name}」 ids=${JSON.stringify(cfg.ids)} | 已扫直播场次 ${Object.keys(lives).length}`);
} catch (e) {
  log('读站点配置失败（用默认目标礼物）：' + String(e.message).slice(0, 100));
}

const isTarget = (name) => {
  const n = String(name || '').trim();
  const want = String(cfg.name || '');
  return !!n && !!want && n.indexOf(want) >= 0;
};

/* ---------- ② 成员目录（成员全名 → uid） ---------- */
let roster = [];
try {
  const r = await fetch(SITE + '/data/members.js');
  const txt = await r.text();
  roster = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  log(`成员目录 ${roster.length} 人`);
} catch (e) {
  console.error('成员目录取不到，无法把「送给 XXX」对到 uid：' + String(e.message).slice(0, 100));
  process.exit(1);
}
// 精确名优先；同名极少，命中多个时取第一个（并在日志里点名）
const byName = new Map();
for (const m of roster) {
  if (!m || !m.n) continue;
  const k = String(m.n).trim();
  if (!byName.has(k)) byName.set(k, []);
  byName.get(k).push(Number(m.id));
}
function memberUid(target) {
  // 弹幕写法是「SNH48-杨秋野」；也有纯昵称的情况，两种都试
  let s = String(target || '').trim();
  const hit = /^[A-Za-z0-9]+-(.+)$/.exec(s);
  const cands = [];
  if (hit) cands.push(hit[1].trim());
  cands.push(s);
  for (const c of cands) {
    const arr = byName.get(c);
    if (arr && arr.length) return arr[0];
  }
  return 0;
}

/* ---------- ③ 直播列表（只要已结束 / 有 LRC 的） ---------- */
async function listLives() {
  const out = new Map();
  let next = '0';
  // 🔴 补历史（LG_SINCE 往前推很多天）时 8 页远远不够：每页 20 场，8 页只 160 场，
  //    而活动期一天就有 100+ 场。LG_PAGES 可调（默认 8 保持日常行为不变）。
  const PAGES = Math.max(1, Number(process.env.LG_PAGES || 8));
  for (let page = 0; page < PAGES; page++) {
    let r;
    try {
      r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 2 });
    } catch (e) {
      log('直播列表失败：' + String(e.message).slice(0, 100));
      break;
    }
    const c = (r && r.content) || {};
    const list = Array.isArray(c.liveList) ? c.liveList : [];
    if (!list.length) break;
    let oldest = Infinity;
    for (const x of list) {
      if (!x || !x.liveId) continue;
      const ct = Number(x.ctime || 0);
      if (ct) oldest = Math.min(oldest, ct);
      out.set(String(x.liveId), {
        liveId: String(x.liveId),
        uid: String((x.userInfo && x.userInfo.userId) || ''),
        nick: String((x.userInfo && x.userInfo.nickname) || ''),
        ctime: ct,
        status: Number(x.status),
      });
    }
    // 已经翻到活动开始之前就没必要继续往回翻
    if (oldest < SINCE) break;
    const nn = c.next;
    if (nn == null || String(nn) === '0' || String(nn) === String(next)) break;
    next = String(nn);
  }
  return [...out.values()].sort((a, b) => b.ctime - a.ctime);
}

const all = await listLives();
// ALL_FORCE=1：无视「已扫过」游标，把 SINCE 之后的所有场次重扫一遍
// （补鸡腿榜历史时用；重扫只会产生相同去重键，站点侧不会重复计分）
const FORCE = process.env.ALL_FORCE === '1';
let cands = all.filter((x) => x.ctime >= SINCE && x.ctime < UNTIL && (FORCE || !lives[x.liveId]));
/* 🔴 补历史（FORCE）必须**从最早往后扫**：`all` 是按 ctime 倒序的，直接 slice(0, MAX)
   每轮都只重扫「最新的 MAX 场」，10-24 下午那批永远轮不到
   （2026-10-25 实测：10-24 22:00 之前的 room=2 一条都没有，就是这个原因）。
   🔴🔴 2026-10-26 二次修正：升序取**前** MAX 又走到了另一个极端 ——
   cron 走 only=all（ALL_FORCE=1）且 LG_SINCE 默认 '2026-10-23'，一天 100+ 场，
   于是每 2 小时都只重扫 10-23 最早那 80 场，**今天的场次永远轮不到**。
   当天 room=2 只剩 53 条（正常 3000+）、谢晓倩/王语晨/项宇婧 直接归零，就是这个。
   ⇒ 日常取**最新**的 MAX 场（slice(-MAX)），要回填历史用 since 显式指定起点。 */
if (FORCE) cands = cands.slice().sort((a, b) => a.ctime - b.ctime);
const todo = FORCE ? cands.slice(-MAX) : cands.slice(0, MAX);
log(`直播共 ${all.length} 场 | ${SINCE_DAY} 之后 ${all.filter((x) => x.ctime >= SINCE).length} 场 | 本轮待扫 ${todo.length} 场`);

/* ---------- ④ 逐场抽礼物 ---------- */
const RE_TAB = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const RE_SP = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\s{2,}送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;

const items = [];
const allItems = [];              // ALL=1：全部礼物（鸡腿榜用）
const ALL = process.env.ALL === '1';
const OUT = process.env.OUT || '';
const newLives = {};
const seenGiftNames = {};
let scanned = 0, hit = 0, noLrc = 0, unmatched = {}, linesTotal = 0;

/* 🔴 补历史（2761 场）时串行只有 ~12 场/分钟，要 4 小时。LG_CONC 并行化；
   日常 cron 仍是 1（保持原来行为，避免给口袋48 加压）。 */
const CONC = Math.max(1, Number(process.env.LG_CONC || 1));
async function scanOne(lv) {
  let url = '';
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: lv.liveId }, { token: TOKEN, retries: 1 });
    url = ((d && d.content) || {}).msgFilePath || '';
  } catch (e) {
    log(`  ✗ ${lv.liveId} ${lv.nick} getLiveOne 失败 ${String(e.message).slice(0, 60)}`);
    return;
  }
  if (!url) { noLrc++; log(`  – ${lv.liveId} ${lv.nick} 没有弹幕文件（可能还在播）`); return; }

  let text = '';
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    log(`  ✗ ${lv.liveId} ${lv.nick} 弹幕下载失败 ${String(e.message).slice(0, 60)}`);
    return;
  }
  const lines = text ? text.split('\n') : [];
  linesTotal += lines.length;
  let got = 0, target = 0;
  for (const line of lines) {
    if (!line) continue;
    const m = line.match(RE_TAB) || line.match(RE_SP);
    if (!m) continue;
    const hh = Number(m[1]) || 0, mi = Number(m[2]) || 0, ss = Number(m[3]) || 0;
    const ms = Number((m[4] || '0').padEnd(3, '0'));
    const nick = String(m[5]).trim();
    const tgt = String(m[6]).trim();
    const num = Math.max(1, Number(m[7]) || 1);
    const gift = String(m[8]).trim();
    got++;
    seenGiftNames[gift] = (seenGiftNames[gift] || 0) + 1;
    // 弹幕时间戳是「开播后经过时间」，加上开播时间才是绝对时间。
    // 🔴 必须是绝对时间：同一场会被重扫，只有 t 稳定，站点侧去重才有效。
    const t = lv.ctime + ((hh * 3600 + mi * 60 + ss) * 1000 + ms);
    const mid = memberUid(tgt);
    if (ALL) {
      // 鸡腿榜：一款礼物都不落，单价按现行价目表算（弹幕这类不計价的道具 priceOf 会给 0）
      allItems.push({ t, mid: mid || 0, sid: 0, sn: nick, g: gift, num, v: priceOf('', gift), room: 2 });
    }
    if (!isTarget(gift)) continue;
    if (!mid) { unmatched[tgt] = (unmatched[tgt] || 0) + 1; continue; }
    items.push({ t, mid, sid: 0, sn: nick, gid: '', g: gift, num, src: 1 });
    target++;
  }
  scanned++;
  hit += target;
  // 行数太少说明弹幕还没写完，先不记游标，下一轮重扫
  if (lines.length >= 50) newLives[lv.liveId] = lv.ctime;
  log(`  ${target ? '🎁' : '  '} ${dayStr(lv.ctime)} ${lv.liveId} ${lv.nick} 行 ${lines.length} 礼物 ${got} → 「${cfg.name}」${target}`);
}

if (CONC === 1) {
  for (const lv of todo) await scanOne(lv);
} else {
  let cur = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = cur++;
      if (i >= todo.length) return;
      await scanOne(todo[i]);
    }
  }));
}

log(`\n扫描 ${scanned} 场 | 弹幕 ${linesTotal} 行 | 命中「${cfg.name}」${hit} 条`);
if (Object.keys(seenGiftNames).length) {
  log('见到的礼物 TOP10：' + JSON.stringify(Object.entries(seenGiftNames).sort((a, b) => b[1] - a[1]).slice(0, 10)));
  const near = Object.keys(seenGiftNames).filter((n) => n.indexOf('弦月') >= 0);
  log('含「弦月」的礼物：' + JSON.stringify(near));
}
if (Object.keys(unmatched).length) log('⚠️ 对不上成员的 target：' + JSON.stringify(unmatched));

/* ---------- ④b 鸡腿榜：全部礼物（ALL=1） ---------- */
if (ALL) {
  // 归不到成员的行（弹幕昵称对不上名册）算不出「谁的鸡腿」，只统计不写库
  const priced = allItems.filter((x) => x.mid);
  let val = 0, num = 0, zero = 0;
  const byGift = {};
  for (const r of priced) {
    val += (r.v || 0) * r.num;
    num += r.num;
    if (!r.v) zero++;
    byGift[r.g] = (byGift[r.g] || 0) + r.num;
  }
  log(`\n[ALL] 全部礼物 ${allItems.length} 条（可归户 ${priced.length}）· 鸡腿 ${val} · 件数 ${num} · 未知价 ${zero} 条`);
  log('[ALL] 礼物 TOP15：' + JSON.stringify(Object.entries(byGift).sort((a, b) => b[1] - a[1]).slice(0, 15)));

  if (OUT) {
    writeFileSync(OUT, JSON.stringify({ at: Date.now(), ch: 'live', items: priced }, null, 0));
    log('[ALL] 写到 ' + OUT);
  }
  // 上报站点 → R2 lv:all:YYYYMMDD（本地 demo 从这里取数，不依赖 runner 产物）
  let pushed = 0;
  for (let i = 0; i < priced.length; i += 2000) {
    const part = priced.slice(i, i + 2000);
    try {
      const res = await fetch(SITE + '/api/lv/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
        body: JSON.stringify({ ch: 'live', items: part }),
      });
      const out = await res.json().catch(() => ({}));
      pushed += part.length;
      log(`[ALL] 上报 ${part.length} 条 → ${JSON.stringify(out.days || out).slice(0, 160)}`);
    } catch (e) {
      log('[ALL] 上报失败：' + String(e.message).slice(0, 120));
    }
  }
  log(`[ALL] 共上报 ${pushed} 条`);
}

/* ---------- ⑤ 上报 ---------- */
if (!items.length && !Object.keys(newLives).length) {
  log('本轮没有新数据，结束。');
  process.exit(0);
}
try {
  const res = await fetch(SITE + '/api/gift/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
    body: JSON.stringify({ items, ch: 'lrc', lives: newLives }),
  });
  const out = await res.json();
  log('上报结果：' + JSON.stringify(out));
} catch (e) {
  console.error('上报失败：' + String(e.message).slice(0, 150));
  process.exit(1);
}
log(`完成，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
