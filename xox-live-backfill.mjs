/**
 * 红蓝歌会 · 直播侧「对账补差」（数据源：xox48.top）
 * =====================================================================
 * 为什么要有这个脚本（2026-10-25 站长反馈「覃柯蒙的怎么没抓到」「很多结束的直播都没抓到」）：
 *
 *   我们自己抓直播礼物一共三条路，但都有硬伤：
 *     ① 48fan SSE（live-sse-sync.mjs）：受「单出口 IP ~6 条并发流」限制，
 *        且接力链一断就整段空白 —— 实测 00:46 之后一份数据都没有；
 *     ② 回放 LRC（backfill-live-gift.mjs）：**只有直播结束之后**才有文件，
 *        正在播的场次拿不到，所以「直播中」永远是 0；
 *     ③ 口袋48 NIM：应用级 403，彻底不通。
 *
 *   而 xox48.top 的 `/Hl/rank` + `/Hl/detail` 是现成的、口径已验证自洽的公开接口：
 *     覃柯蒙 直播间 38 条 = 673 分、房间 21 条 = 137 分，与它自己给的
 *     `live_vote`/`room_vote` 一分不差；**直播进行中就在更新**。
 *
 *   于是本脚本只做一件事：**把 xox48 有、我们没有的那部分补进站里**。
 *
 * 🔴 核心是「对账」而不是「再灌一遍」：
 *   同一份礼物，我们自己的记录和 xox48 的记录**时间戳口径不同**（我们 SSE 用 serverTime、
 *   LRC 用 ctime+弹幕偏移、xox 用它自己的入库时间），直接倒进去就是双倍计分。
 *   所以按「同成员 + 同送礼人昵称 + 同份数 + 时间差 <= TOL」做一对一匹配，
 *   已经匹配上的就当已有，只把**匹配不上的**补进去。
 *
 * 🔴 只补「直播间」（type=1）：
 *   房间侧（type=2）我们自己抓得很准（覃柯蒙 我们 136 / xox 137，差 1），
 *   补房间会和我们自采的记录互相撞车，得不偿失。房间侧继续走 gift-sync.mjs。
 *
 * 用法：
 *   node xox-live-backfill.mjs                 # 正式补差（默认起点=北京今天 0 点退 6 小时）
 *   DRY=1 node xox-live-backfill.mjs           # 只打印不写入
 *   MEMBER=覃柯蒙 node ...                     # 只处理某个成员（调试最快）
 *   SINCE=2026-10-24T00:00:00+08:00 node ...   # 自定义起点（补历史）
 *   TOL=20 node ...                            # 匹配容差（分钟，默认 20）
 *   CONC=4 node ...                            # 并发
 *
 * 环境变量：SITE_URL / INGEST_TOKEN
 */
const SITE = (process.env.SITE_URL || 'https://all48.wyc0518.cc').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const DRY = !!process.env.DRY;
const ONLY = (process.env.MEMBER || '').trim();
const CONC = Math.max(1, Number(process.env.CONC || 4));
const TOL = Math.max(1, Number(process.env.TOL || 20)) * 60000;
const XOX = 'https://xox48.top';
const BJ = 8 * 3600 * 1000;

import { reconcileRows, indexByMid } from './lib/reconcile.mjs';

const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().replace('T', ' ').slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 时间 */
function todayBjStart() { return Math.floor((Date.now() + BJ) / 86400000) * 86400000 - BJ; }
function parseSince(s) {
  if (!s) return todayBjStart() - 6 * 3600 * 1000;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(\+\d{2}:?\d{2})?$/.exec(s.trim());
  if (m) {
    const [, y, mo, d, hh = 0, mi = 0, ss = 0] = m;
    return Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) - BJ;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : todayBjStart() - 6 * 3600 * 1000;
}
const SINCE = parseSince(process.env.SINCE);
const bjDayOf = (ms) => new Date(Number(ms) + BJ).toISOString().slice(0, 10).replace(/-/g, '');
/** "2026-10-24 23:01:27"（北京时间）→ ms */
function parseBj(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - BJ;
}

/* ------------------------------------------------------------ 成员键 */
// 与 worker 的 memberKey 完全一致（对外键 k，不泄露口袋48 ID）
function memberKey(uid) {
  const str = 'm' + (Number(uid) || 0);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'k' + h.toString(36);
}

/* -------------------------------------------------------------- 网络 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** xox48 只吃 form-urlencoded（前端 qs.stringify）；发 JSON 会报「缺少参数 keys」 */
async function xoxPost(path, obj) {
  const body = new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, v == null ? '' : String(v)])).toString();
  // 🔴 重试要比别的接口更耐心：xox48 在并发高时会直接掐连接（Node 侧表现为 fetch failed，
  //    不是 HTTP 错误码）。实测 CONC=6 时有近半数请求被掐，降到 2 并拉长退避才稳。
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(XOX + path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, origin: XOX, referer: XOX + '/v2024/' },
        body,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (Number(j.error) !== 0) throw new Error('xox error=' + j.error + ' ' + (j.msg || ''));
      return j;
    } catch (e) {
      if (i === 4) throw e;
      await sleep(1200 * (i + 1));
    }
  }
}

async function siteGet(path) {
  // 🔴 必须带浏览器 UA：wyc0518.cc 开了 Bot Fight，裸请求会被 CF 挡成挑战页
  const r = await fetch(SITE + path, { headers: { 'user-agent': UA, 'x-ingest-token': INGEST, accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ------------------------------------------------------- 成员目录 */
async function loadRoster() {
  const txt = await (await fetch(SITE + '/data/members.js', { headers: { 'user-agent': UA } })).text();
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  const byName = new Map();   // 昵称(去空格) → uid
  const byId = new Map();
  for (const m of arr) {
    if (!m || !m.id) continue;
    byId.set(Number(m.id), m);
    const k = String(m.n || '').replace(/\s+/g, '');
    if (k && !byName.has(k)) byName.set(k, Number(m.id));
  }
  return { byName, byId, list: arr };
}

/** 「SNH48-覃柯蒙」/「覃柯蒙」→ uid（与 nim-parse 的 memberUid 同思路） */
function makeResolver(roster) {
  return (raw) => {
    let s = String(raw || '').replace(/\s+/g, '');
    if (!s) return 0;
    const hit = /^[A-Za-z0-9]+-(.+)$/.exec(s);
    const cands = hit ? [hit[1], s] : [s];
    for (const c of cands) {
      const uid = roster.byName.get(c);
      if (uid) return uid;
      // 兜底：成员表里有人带「·」或后缀，做包含匹配（只在唯一命中时才认）
      const fuzzy = [];
      for (const [n, id] of roster.byName) if (n.includes(c)) fuzzy.push(id);
      if (fuzzy.length === 1) return fuzzy[0];
    }
    return 0;
  };
}

/* ------------------------------------------------------ xox48 明细 */
async function xoxLiveRows(cyId) {
  const out = [];
  for (let page = 1; page <= 40; page++) {
    const j = await xoxPost('/Hl/detail', { cy_id: cyId, start: '2026-10-20', end: '2026-12-31', type: '1', page });
    const d = j.data || {};
    const arr = Array.isArray(d.list) ? d.list : [];
    for (const r of arr) {
      const t = parseBj(r.msg_time);
      if (!t || t < SINCE) continue;
      out.push({ t, sn: String(r.user_name || '').slice(0, 40), num: Math.max(1, Number(r.vote) || 1) });
    }
    if (!arr.length || out.length >= Number(d.count || 0)) break;
    await sleep(120);
  }
  return out;
}

/* ------------------------------------------------- 站点已有直播记录 */
// 🔴 用 /api/gift/liveall 一次拉全站（而不是每人一个 /api/gift/detail）：
//    191 个成员就是 191 次请求，还各自读一遍当天的 R2 文件，慢且浪费。
async function fetchLiveAll() {
  const from = bjDayOf(SINCE), to = bjDayOf(Date.now());
  const j = await siteGet(`/api/gift/liveall?from=${from}&to=${to}`);
  const idx = indexByMid(j.rows || []);
  log(`站内已有直播记录 ${(j.rows || []).length} 条 · 涉及 ${idx.size} 位成员`);
  return idx;
}

/* ------------------------------------------------------------ 对账 */
// 规则见 lib/reconcile.mjs：同昵称 + 同份数 + |Δt| <= TOL 一对一匹配，
// 匹配不上的才是「我们确实没有」、可以补的。
const reconcile = (mine, theirs) => reconcileRows(mine, theirs, TOL);

/* ------------------------------------------------------------ 上报 */
async function ingest(items) {
  if (!items.length) return { added: 0 };
  let added = 0;
  for (let i = 0; i < items.length; i += 2000) {
    const chunk = items.slice(i, i + 2000);
    const r = await fetch(SITE + '/api/gift/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST, 'user-agent': UA },
      body: JSON.stringify({ items: chunk, stats: { 'xox48补差': chunk.length } }),
    });
    const out = await r.json().catch(() => ({}));
    added += Number(out && out.added) || 0;
    log(`  ↑ 上报 ${chunk.length} 条 → kept=${out.kept} dropped=${out.dropped} added=${out.added}`);
  }
  return { added };
}

/* ------------------------------------------------------------ 本地缓存 */
// 🔴 为什么必须有（2026-10-25 实测）：xox48 是个小站，全员明细一轮要 250+ 次请求，
//    连打两轮它就掐我们连接（undici 报 `other side closed`，看起来像网络故障，其实是限流）。
//    所以把「上一次拉到该成员时的 live_vote」记在本地，这一轮只有**分数变了**的成员才去拉明细。
//    稳态下每轮只有几个正在直播的成员会变 ⇒ 请求量从 250+ 掉到个位数。
const CACHE_FILE = process.env.XOX_CACHE || './.xox-cache.json';
let cache = {};
try { cache = JSON.parse(await (await import('node:fs/promises')).readFile(CACHE_FILE, 'utf8')) || {}; } catch { cache = {}; }
async function saveCache() {
  try {
    const fs = await import('node:fs/promises');
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache));
  } catch (e) { log('缓存写入失败：' + String(e.message).slice(0, 60)); }
}

/* ---------------------------------------------------------- 主流程 */
async function main() {
  const t0 = Date.now();
  if (!INGEST && !DRY) throw new Error('缺少 INGEST_TOKEN');
  log(`=== xox48 直播侧对账补差 起算 ${new Date(SINCE + BJ).toISOString().slice(0, 19).replace('T', ' ')}（北京）· 容差 ${TOL / 60000} 分钟 ===`);

  const roster = await loadRoster();
  const resolve = makeResolver(roster);
  log(`成员目录 ${roster.list.length} 人`);

  // 目标礼物名以站里配置为准（活动期间道具会改名，写死就会在改名那天静默失效）
  let GIFTCFG = process.env.GIFT_NAME || '';
  if (!GIFTCFG) {
    try {
      const j = await siteGet('/api/gift/cursor');
      GIFTCFG = String((j.cfg && j.cfg.name) || '').trim() || '弦月回响';
    } catch { GIFTCFG = '弦月回响'; }
  }
  log(`目标礼物「${GIFTCFG}」`);

  let rank;
  try {
    rank = await xoxPost('/Hl/rank', {});
  } catch (e) {
    log(`xox48 榜取不到（多半是被限流，等几分钟再来）：${String(e.message).slice(0, 90)}`);
    process.exit(0);
  }
  let list = (rank.data && rank.data.list) || [];
  log(`xox48 榜 ${list.length} 人 · live 合计 ${list.reduce((a, b) => a + Number(b.live_vote || 0), 0)}`);

  if (ONLY) {
    list = list.filter((x) => String(x.nickname || '').includes(ONLY));
    log(`按 MEMBER=${ONLY} 过滤后 ${list.length} 人`);
  }
  // 只要还有直播分的
  list = list.filter((x) => Number(x.live_vote || 0) > 0);

  // 只处理「还有直播分」的成员；真要不要拉明细，由 worker 里的两道闸决定（见下）
  log(`候选成员 ${list.length} 人（逐个判断是否真有缺口）`);

  const mineIndex = await fetchLiveAll();

  let idx = 0, grandXox = 0, grandOurs = 0, grandAdd = 0, grandAdded = 0;
  const allAdd = [];
  const report = [];

  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= list.length) return;
      const x = list[i];
      const uid = Number(x.cy_id) || 0;
      const nick = String(x.nickname || '');
      if (!uid) continue;
      // 🔴 省请求的两道闸（xox48 会被打限流，250 次/轮是打不动的）：
      //   ① 我们的份数已经追平它报的 live_vote ⇒ 根本没缺口，连明细都不用拉；
      //   ② 最近 10 分钟内拉过、且它的分数没变 ⇒ 那次已经补过，不用再问。
      //   这样无直播的静默期整轮只剩 2 个请求（rank + liveall）。
      const mine0 = mineIndex.get(uid) || [];
      const mineSum0 = mine0.reduce((a, b) => a + b.num, 0);
      const target = Number(x.live_vote) || 0;
      if (mineSum0 >= target) continue;
      const c0 = cache[String(uid)];
      if (c0 && Number(c0.vote) === target && Date.now() - Number(c0.at || 0) < 10 * 60000) continue;
      try {
        const theirs = await xoxLiveRows(uid);
        if (!theirs.length) continue;
        const mine = mineIndex.get(uid) || [];
        const missing = reconcile(mine, theirs);
        const sumX = theirs.reduce((a, b) => a + b.num, 0);
        const sumO = mine.reduce((a, b) => a + b.num, 0);
        const sumM = missing.reduce((a, b) => a + b.num, 0);
        grandXox += sumX; grandOurs += sumO; grandAdd += sumM;
        if (sumM > 0) {
          report.push({ nick, uid, sumX, sumO, sumM, rows: theirs.length, missing: missing.length });
          for (const m of missing) {
            allAdd.push({ t: m.t, mid: uid, sid: 0, sn: m.sn, gid: '', g: GIFTCFG, num: m.num, src: 1 });
          }
          log(`  ${nick}: xox ${sumX} · 我们 ${sumO} · 补 ${sumM}（${missing.length} 条）`);
        }
        // 拉成功了才记缓存：失败的要留到下一轮重试，否则那一场的分就永久漏了
        cache[String(uid)] = { vote: Number(x.live_vote) || 0, at: Date.now(), sum: sumX };
      } catch (e) {
        log(`  [${nick}] 失败：${String(e.message).slice(0, 90)}`);
      }
      await sleep(350);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, worker));

  report.sort((a, b) => b.sumM - a.sumM);
  log(`\n有缺口的成员 ${report.length} 人`);
  for (const r of report.slice(0, 25)) {
    log(`  ${r.nick.padEnd(8, ' ')} xox ${String(r.sumX).padStart(5)} | 我们 ${String(r.sumO).padStart(5)} | 缺口 ${String(r.sumM).padStart(5)}`);
  }
  log(`\n合计：xox ${grandXox} · 我们已有 ${grandOurs} · 应补 ${grandAdd}（${allAdd.length} 条）`);

  if (DRY) {
    log('[DRY] 不写入');
  } else if (allAdd.length) {
    const { added } = await ingest(allAdd);
    grandAdded = added;
    log(`实际入库 ${added} 条`);
  }
  // 缓存落盘（含本轮成功的成员），下一轮只拉变动的
  if (!DRY) await saveCache();
  log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/* ------------------------------------------------------ 离线自检 */
function selftest() {
  const mine = [
    { t: 1000000, sn: '小明', num: 8 },
    { t: 2000000, sn: '小红', num: 2 },
  ];
  const theirs = [
    { t: 1000000 + 60000, sn: '小明', num: 8 },   // 已有一份（差 1 分钟）→ 不应补
    { t: 2000000 + 900000, sn: '小红', num: 2 },  // 差 15 分钟，在容差内 → 不应补
    { t: 3000000, sn: '小刚', num: 1 },           // 我们没有 → 补
    { t: 1000000 + 500, sn: '小明', num: 8 },     // 又一条同人同量（另一份真礼物）→ 配不上，补
  ];
  const missing = reconcileRows(mine, theirs, 20 * 60000);
  const ok = missing.length === 2 && missing.every((m) => m.sn !== '小红');
  console.log('自检：应补', missing.length, '条（期望 2：小刚 + 小明第二份）', ok ? '✅' : '❌');
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes('--selftest')) selftest();
else await main();
