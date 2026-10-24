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
 */
import { postJson } from './lib/api.mjs';

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
  for (let page = 0; page < 8; page++) {
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
const todo = all.filter((x) => x.ctime >= SINCE && !lives[x.liveId]).slice(0, MAX);
log(`直播共 ${all.length} 场 | ${SINCE_DAY} 之后 ${all.filter((x) => x.ctime >= SINCE).length} 场 | 本轮待扫 ${todo.length} 场`);

/* ---------- ④ 逐场抽礼物 ---------- */
const RE_TAB = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const RE_SP = /^\[(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.+?)\s{2,}送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;

const items = [];
const newLives = {};
const seenGiftNames = {};
let scanned = 0, hit = 0, noLrc = 0, unmatched = {}, linesTotal = 0;

for (const lv of todo) {
  let url = '';
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: lv.liveId }, { token: TOKEN, retries: 1 });
    url = ((d && d.content) || {}).msgFilePath || '';
  } catch (e) {
    log(`  ✗ ${lv.liveId} ${lv.nick} getLiveOne 失败 ${String(e.message).slice(0, 60)}`);
    continue;
  }
  if (!url) { noLrc++; log(`  – ${lv.liveId} ${lv.nick} 没有弹幕文件（可能还在播）`); continue; }

  let text = '';
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    log(`  ✗ ${lv.liveId} ${lv.nick} 弹幕下载失败 ${String(e.message).slice(0, 60)}`);
    continue;
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
    if (!isTarget(gift)) continue;
    const mid = memberUid(tgt);
    if (!mid) { unmatched[tgt] = (unmatched[tgt] || 0) + 1; continue; }
    // 弹幕时间戳是「开播后经过时间」，加上开播时间才是绝对时间。
    // 🔴 必须是绝对时间：同一场会被重扫，只有 t 稳定，站点侧去重才有效。
    const t = lv.ctime + ((hh * 3600 + mi * 60 + ss) * 1000 + ms);
    items.push({ t, mid, sid: 0, sn: nick, gid: '', g: gift, num, src: 1 });
    target++;
  }
  scanned++;
  hit += target;
  // 行数太少说明弹幕还没写完，先不记游标，下一轮重扫
  if (lines.length >= 50) newLives[lv.liveId] = lv.ctime;
  log(`  ${target ? '🎁' : '  '} ${dayStr(lv.ctime)} ${lv.liveId} ${lv.nick} 行 ${lines.length} 礼物 ${got} → 「${cfg.name}」${target}`);
}

log(`\n扫描 ${scanned} 场 | 弹幕 ${linesTotal} 行 | 命中「${cfg.name}」${hit} 条`);
if (Object.keys(seenGiftNames).length) {
  log('见到的礼物 TOP10：' + JSON.stringify(Object.entries(seenGiftNames).sort((a, b) => b[1] - a[1]).slice(0, 10)));
  const near = Object.keys(seenGiftNames).filter((n) => n.indexOf('弦月') >= 0);
  log('含「弦月」的礼物：' + JSON.stringify(near));
}
if (Object.keys(unmatched).length) log('⚠️ 对不上成员的 target：' + JSON.stringify(unmatched));

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
