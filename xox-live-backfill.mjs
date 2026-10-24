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
 * 🔴 核心是「双向对账」而不是「以 xox 为准再灌一遍」：
 *   同一份礼物，我们自己的记录和 xox48 的记录**时间戳口径不同**（我们 SSE 用 serverTime、
 *   LRC 用 ctime+弹幕偏移、xox 用它自己的入库时间），直接倒进去就是双倍计分。
 *   所以按「同成员 + 同送礼人昵称 + 同份数 + 时间差 <= TOL」做一对一匹配：
 *     · xox 有、我们配不上的 → 补（我们确实缺）
 *     · 我们有、xox 配不上的 → **保留不动**（我们抓到了它漏的，2026-10-25 站长：
 *       「我们的不一定错 所以要对账 对方也有少的」）
 *   最终站里 = 两边并集。任何「以 xox 为准删我们记录」的做法都是错的。
 *
 * 🔴 直播侧（SRC=1，默认）与房间侧（SRC=0）走同一套对账，只是数据源明细类型不同：
 *   type=1 对准 `live_vote`，type=2 对准 `room_vote`。
 *   房间侧也要补（2026-10-25「数据一定要准确」）：我们自采房间是 2 页/2 分钟，
 *   热门房间会漏（阙佳慧 xox 68 条 210 分 / 我们 53 条 171 分）。
 *   房间补差的记录**没有送礼人 uid**（xox 只给昵称），落库时 sid=0，
 *   聚合时 worker 会拿同昵称的历史记录回查 uid（`nickUid`），查不到就按昵称单独聚。
 *
 * 用法：
 *   node xox-live-backfill.mjs                 # 正式补差（默认起点=北京今天 0 点退 6 小时）
 *   DRY=1 node xox-live-backfill.mjs           # 只打印不写入
 *   SRC=0 node xox-live-backfill.mjs           # 补房间侧
 *   SRC=all node xox-live-backfill.mjs         # 两路都补
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
/** FORCE=1 跳过「10 分钟内拉过且分数没变」的闸门（对账核实用，会给 xox 加压，别常开） */
const FORCE = !!process.env.FORCE;
const ONLY = (process.env.MEMBER || '').trim();
const CONC = Math.max(1, Number(process.env.CONC || 4));
const TOL = Math.max(1, Number(process.env.TOL || 20)) * 60000;
const XOX = 'https://xox48.top';
const BJ = 8 * 3600 * 1000;
/** 要补哪一路：1=直播（默认） 0=房间 'all'=两路 */
const SRC_RAW = String(process.env.SRC == null ? '1' : process.env.SRC).trim().toLowerCase();
const SRC_LIST = SRC_RAW === 'all' ? [1, 0] : [Number(SRC_RAW) === 0 ? 0 : 1];
/** 可选：把双向对账结果写成 JSON（REPORT=/path/to.json） */
const REPORT_FILE = (process.env.REPORT || '').trim();

import { reconcileRows, indexByMid } from './lib/reconcile.mjs';

const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().replace('T', ' ').slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- 时间 */
function todayBjStart() { return Math.floor((Date.now() + BJ) / 86400000) * 86400000 - BJ; }
/**
 * 🔴 默认起点 = **北京昨天 0 点**（不是「今天 0 点退 6 小时」）。
 *    xox48 的 vote / live_vote / room_vote 是**全天累计**，我们站里的分数也是全天累计；
 *    起点若只退 6 小时，昨天白天那一段就永远补不上 ——
 *    实测王唯祎 room_vote 39、明细 29 条里有 20 条在 18:00 之前，
 *    按 6 小时窗口只看到 3 分，于是「缺口」被判成 2 分（真缺口 38 分）。
 */
function parseSince(s) {
  if (!s) return todayBjStart() - 24 * 3600 * 1000;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(\+\d{2}:?\d{2})?$/.exec(s.trim());
  if (m) {
    const [, y, mo, d, hh = 0, mi = 0, ss = 0] = m;
    return Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) - BJ;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : todayBjStart() - 24 * 3600 * 1000;
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
/**
 * @param cyId 成员 cy_id
 * @param src  1=直播间明细（type=1） 0=房间明细（type=2）
 */
async function xoxRows(cyId, src) {
  const out = [];
  const type = src === 1 ? '1' : '2';
  for (let page = 1; page <= 40; page++) {
    const j = await xoxPost('/Hl/detail', { cy_id: cyId, start: '2026-10-20', end: '2026-12-31', type, page });
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

/* ------------------------------------------------- 站点已有记录 */
// 🔴 用 /api/gift/liveall 一次拉全站（而不是每人一个 /api/gift/detail）：
//    191 个成员就是 191 次请求，还各自读一遍当天的 R2 文件，慢且浪费。
async function fetchAll(src) {
  const from = bjDayOf(SINCE), to = bjDayOf(Date.now());
  const j = await siteGet(`/api/gift/liveall?from=${from}&to=${to}&src=${src}`);
  // 只留这一路（接口按 src 过滤，这里再筛一次防上游改动）
  const rows = (j.rows || []).filter((r) => Number(r[4]) === src);
  const idx = indexByMid(rows);
  log(`站内已有${src === 1 ? '直播' : '房间'}记录 ${rows.length} 条 · 涉及 ${idx.size} 位成员`);
  return idx;
}

/**
 * 🔴 双向对账（2026-10-25 站长：「我们的不一定错 所以要对账 对方也有少的」）
 *
 *   `reconcileRows(mine, theirs)` 只回答「xox 有、我们缺什么」。
 *   但反过来也存在「我们有、xox 没有」—— 那是**我们抓到了它漏掉的**，
 *   是最不该被丢掉的数据。所以每次对账都要把两个方向都算出来：
 *
 *     forgot  = 我们缺的（要补，来源 = xox）
 *     oursOnly = 我们独有的（**一分都不动**，xox 漏了而已）
 *
 *   最终站里的数据 = 两边取并集，而不是以 xox 为唯一真值。
 *   ⚠️ 也正因为如此，任何「以 xox 为准去删我们记录」的操作都是错的。
 */
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
      // 🔴 reconciled:true —— 这一批已经在本地做过 20 分钟窗口对账，让 worker 跳过 15 秒模糊去重。
      //    不跳的话「同一个人连送 N 次、我们少抓到中间那条」永远补不上：
      //    判缺的条目会撞上邻座那条毫秒级的已有记录，被当重复拦掉（见 worker handleGiftIngest 注释）。
      body: JSON.stringify({ items: chunk, reconciled: true, stats: { 'xox48补差': chunk.length } }),
    });
    const out = await r.json().catch(() => ({}));
    added += Number(out && out.added) || 0;
    log(`  ↑ 上报 ${chunk.length} 条 → kept=${out.kept} dropped=${out.dropped} fuzzy=${out.fuzzyDropped || 0} added=${out.added}`);
  }
  return { added };
}

/* ----------------------------------------------------- 名册自动校准 */
/**
 * 站点名册（data/members.js）是静态文件，官方随时补人 / 移籍换队，静态表跟不上，
 * 结果就是「有人收礼、榜上查无此人」（2026-10-25：张林雪 / 李玉晴 / 武佳凝 不在册）。
 * 站长要求「新成员实时补上」「队伍变化也要跟上」。
 *
 * xox48 榜每行都带 `cy_id`（= 口袋48 成员 ID）+ `nickname` + `gname` + `tname`，
 * 而且跟着官方实时变 ⇒ 直接拿它校准站内名册，推到 worker 的 KV `roster:extra`。
 *
 * 🔴 团/队缩写必须映射，且**必须自洽**才采用：
 *    队所属的团要和 gname 一致，否则说明 xox 的这两列有一个是脏的（实测徐钰涵
 *    gname=CGT tname=G2 是自洽的 ⇒ CGT48 TEAM GII；若出现 CKG + H2 这种就丢弃）。
 *    映射表外的值一律不推，宁可让名册旧一点，也不能把人的团/队写错。
 */
const XOX_G = { SNH: 'SNH48', GNZ: 'GNZ48', BEJ: 'BEJ48', CGT: 'CGT48', CKG: 'CKG48', IDFT: 'IDFT' };
// 队缩写 → [队名, 所属团]；预备生（YBS）不属于任何队，团名由 gname 定
const XOX_T = {
  S2: ['TEAM SII', 'SNH48'], N2: ['TEAM NII', 'SNH48'], H2: ['TEAM HII', 'SNH48'], X: ['TEAM X', 'SNH48'],
  N3: ['TEAM NIII', 'GNZ48'], G: ['TEAM G', 'GNZ48'], Z: ['TEAM Z', 'GNZ48'],
  B: ['TEAM B', 'BEJ48'], E: ['TEAM E', 'BEJ48'],
  C: ['TEAM C', 'CKG48'], K: ['TEAM K', 'CKG48'],
  C2: ['TEAM CII', 'CGT48'], G2: ['TEAM GII', 'CGT48'],
  YBS: ['预备生', null],
};

/** 把 xox 榜转成站点名册行 [uid, name, g, tm]，丢掉映射不出来 / 团队不自洽的 */
function rosterRowsFromXox(list) {
  const rows = [];
  let skipped = 0;
  for (const x of list || []) {
    const uid = Number(x && x.cy_id) || 0;
    const name = String((x && x.nickname) || '').trim();
    if (!uid || !name) { skipped += 1; continue; }
    const g = XOX_G[String(x.gname || '').trim().toUpperCase()] || '';
    const t = XOX_T[String(x.tname || '').trim().toUpperCase()];
    if (!g || !t) { skipped += 1; continue; }
    if (t[1] && t[1] !== g) { skipped += 1; continue; }   // 团队不自洽 → 不采用
    rows.push([uid, name, g, t[0]]);
  }
  return { rows, skipped };
}

/* --------------------------------------- 官方全团表（团/队的权威源） */
/**
 * 🔴 为什么不能只信 xox（2026-10-25 实测）：
 *    xox 的 tname 有 70/192 是 YBS（预备生），把「名册明明是 TEAM NII 的人」也说成预备生；
 *    而站内名册（官方表同步来的）也有滞后，比如把左婧媛写成了「预备生」。
 *    两边各错一半 ⇒ 单信任何一边都会写错。
 *
 *    所以团队以**官方全团表**（h5.48.cn allmembers_0.jsonp，761 人，移籍当天就更新）为准：
 *      · 官方表能唯一查到这个人 → 用官方的团/队
 *      · 官方表查不到（新到官方表还没收录）→ 退回 xox 的值
 *    这张表就是 sync-roster.mjs 用的同一份，映射规则（TEAM SII / 预备生 这种写法）也一致。
 */
const OFFICIAL_URL = 'https://h5.48.cn/resource/json/allmembers_0.jsonp';
const GROUP_MAP = { SNH: 'SNH48', GNZ: 'GNZ48', BEJ: 'BEJ48', CKG: 'CKG48', CGT: 'CGT48', SHY: 'SHY48', IDFT: 'IDFT' };
const TEAM_SET = new Set(['SII', 'NII', 'HII', 'X', 'XII', 'G', 'NIII', 'Z', 'B', 'E', 'J',
  'C', 'K', 'CII', 'GII', 'SIII', 'HIII', 'Ft']);

/** 与 sync-roster.mjs 的 mapTeam 完全一致，保证站内写法统一 */
function mapTeam(gname, tname) {
  const t = String(tname || '').trim();
  if (!t) return '';
  if (t === '荣誉毕业生') return '荣誉毕业生';
  if (/预备生$/.test(t)) return '预备生';
  if (t.toLowerCase() === 'idft') return 'IDFT';
  if (TEAM_SET.has(t)) return 'TEAM ' + t;
  const g = GROUP_MAP[String(gname || '').trim().toUpperCase()];
  if (g && (t === g || t === g.replace('48', '') || t === g + '48')) return t;
  if (t === '未入列') return '未入列';
  return t;
}

async function fetchOfficialIndex() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(OFFICIAL_URL, { headers: { 'user-agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      const o = JSON.parse(txt.slice(txt.indexOf('(') + 1, txt.lastIndexOf(')')));
      const rows = o.rows || [];
      if (rows.length < 500) throw new Error('行数异常 ' + rows.length);
      const byName = new Map();
      for (const r of rows) {
        const n = fuzzNick(r.sname);
        if (!n) continue;
        const a = byName.get(n);
        if (a) a.push(r); else byName.set(n, [r]);
      }
      log(`官方全团表 ${rows.length} 人（团/队权威源）`);
      return byName;
    } catch (e) {
      if (i === 2) { log('官方表取不到，团队退回用 xox 的值：' + String(e.message).slice(0, 60)); return null; }
      await sleep(1500);
    }
  }
  return null;
}

const fuzzNick = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();

/**
 * 名册校准：**只补人，不改人**。
 *
 * 🔴 站长定案（2026-10-25）：「我们是对的 对方的队伍不对」——
 *    站内名册的团/队是可信的，xox48 的 `tname` 有 70/192 是 YBS（把明明在某队的人说成预备生），
 *    所以：
 *      · 名册里已有的人 → **一个字都不改**（哪怕 xox 说不一样）
 *      · 只把「名册里完全没有的人」补进来（不补就完全看不到这个人）
 *      · 补进来时团队取**官方全团表**（h5.48.cn，和 sync-roster.mjs 同一份），
 *        官方表也查不到就不猜队（留空），绝不把 xox 的错队写进名册
 */
async function pushRoster(list, roster) {
  const { rows, skipped } = rosterRowsFromXox(list);
  if (!rows.length) return;

  // 先挑出「名册没有的人」，没有就不必去拉官方表了
  const fresh = rows.filter((r) => !(roster && roster.byId && roster.byId.get(r[0])));
  log(`名册校准：xox ${rows.length} 人（映射不明 ${skipped}）· 名册已有 ${rows.length - fresh.length} 人（一律不动）· 缺 ${fresh.length} 人`);
  if (!fresh.length) return;

  const offIdx = await fetchOfficialIndex();
  const todo = [];
  let fromOfficial = 0, guessedG = 0;
  for (const r of fresh) {
    const a = offIdx ? offIdx.get(fuzzNick(r[1])) : null;
    let g = r[2];
    let tm = '';
    if (a && a.length === 1) {
      const og = GROUP_MAP[String(a[0].gname || '').trim().toUpperCase()];
      const ot = mapTeam(a[0].gname, a[0].tname);
      if (og) g = og;
      if (ot) tm = ot;
      fromOfficial += 1;
    } else {
      guessedG += 1;   // 官方表还没收录（多半是刚出道的）→ 团用 xox 的，队留空不猜
    }
    todo.push([r[0], r[1], g, tm]);
  }
  log(`  团队来源：官方表 ${fromOfficial} 人 · 官方表未收录 ${guessedG} 人（队留空）`);

  try {
    const r = await fetch(SITE + '/api/roster/extra', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST, 'user-agent': UA },
      body: JSON.stringify({ rows: todo }),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) {
      log(`  → 新增 ${j.added} · 更新 ${j.updated} · 库内 ${j.total}${j.written ? '' : '（无变化）'}`);
      for (const t of todo.slice(0, 10)) log(`     + ${t[1]} → ${t[2]}${t[3] ? ' / ' + t[3] : ''}`);
    } else {
      log(`名册校准失败：${JSON.stringify(j).slice(0, 120)}`);
    }
  } catch (e) {
    log(`名册校准失败：${String(e.message).slice(0, 80)}`);
  }
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
const SRC_NAME = (src) => (src === 1 ? '直播间' : '房间');
const TARGET_FIELD = (src) => (src === 1 ? 'live_vote' : 'room_vote');

async function main() {
  const t0 = Date.now();
  if (!INGEST && !DRY) throw new Error('缺少 INGEST_TOKEN');
  log(`=== xox48 对账补差（${SRC_LIST.map(SRC_NAME).join(' + ')}） 起算 ${new Date(SINCE + BJ).toISOString().slice(0, 19).replace('T', ' ')}（北京）· 容差 ${TOL / 60000} 分钟 ===`);

  const roster = await loadRoster();
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
  const full = (rank.data && rank.data.list) || [];
  log(`xox48 榜 ${full.length} 人 · 直播合计 ${full.reduce((a, b) => a + Number(b.live_vote || 0), 0)} · 房间合计 ${full.reduce((a, b) => a + Number(b.room_vote || 0), 0)}`);

  // 每轮顺手校准站内名册：新人补进来、移籍换队跟着改（见 rosterRowsFromXox 注释）
  if (!DRY) await pushRoster(full, roster);

  let grandAddedTotal = 0;
  for (const src of SRC_LIST) {
    const field = TARGET_FIELD(src);
    let list = full;
    if (ONLY) list = list.filter((x) => String(x.nickname || '').includes(ONLY));
    // 只处理「这一路还有分」的成员
    list = list.filter((x) => Number(x[field] || 0) > 0);
    log(`\n---- ${SRC_NAME(src)}侧：候选 ${list.length} 人 ----`);
    if (!list.length) continue;

    const mineIndex = await fetchAll(src);
    let idx = 0;
    const allAdd = [];
    const report = [];

    async function run() {
      for (;;) {
        const i = idx++;
        if (i >= list.length) return;
        const x = list[i];
        const uid = Number(x.cy_id) || 0;
        const nick = String(x.nickname || '');
        if (!uid) continue;
        // 🔴 省请求的两道闸（xox48 会被打限流，全员明细一轮 250+ 次请求是打不动的）：
        //   ① 我们的份数已经追平它报的分数 ⇒ 根本没缺口，连明细都不用拉；
        //   ② 最近 10 分钟内拉过、且它的分数没变 ⇒ 那次已经补过，不用再问。
        //   这样无直播的静默期整轮只剩 2 个请求（rank + liveall）。
        const mine0 = mineIndex.get(uid) || [];
        const mineSum0 = mine0.reduce((a, b) => a + b.num, 0);
        const target = Number(x[field]) || 0;
        if (mineSum0 >= target) continue;
        const ck = uid + (src === 1 ? ':l' : ':r');
        const c0 = cache[ck];
        if (!FORCE && c0 && Number(c0.vote) === target && Date.now() - Number(c0.at || 0) < 10 * 60000) continue;
        try {
          const theirs = await xoxRows(uid, src);
          if (!theirs.length) continue;
          const mine = mineIndex.get(uid) || [];
          const forgot = reconcile(mine, theirs);            // xox 有、我们缺 → 补
          const oursOnly = reconcile(theirs, mine);          // 我们有、xox 没 → 只记进报告，不动
          const sumX = theirs.reduce((a, b) => a + b.num, 0);
          const sumO = mine.reduce((a, b) => a + b.num, 0);
          const sumM = forgot.reduce((a, b) => a + b.num, 0);
          const sumU = oursOnly.reduce((a, b) => a + b.num, 0);
          if (sumM > 0 || sumU > 0) {
            report.push({
              nick, uid, sumX, sumO, sumM, sumU,
              rows: theirs.length, mineRows: mine.length,
              missing: forgot.length, oursOnlyCnt: oursOnly.length,
            });
            for (const m of forgot) {
              allAdd.push({ t: m.t, mid: uid, sid: 0, sn: m.sn, gid: '', g: GIFTCFG, num: m.num, src });
            }
            if (sumM > 0) log(`  ${nick}: xox ${sumX} · 我们 ${sumO} · 补 ${sumM}（${forgot.length} 条）${sumU ? ` · 我们独有 ${sumU}` : ''}`);
          }
          // 拉成功了才记缓存：失败的要留到下一轮重试，否则那一段的分就永久漏了
          cache[ck] = { vote: target, at: Date.now(), sum: sumX };
        } catch (e) {
          log(`  [${nick}] 失败：${String(e.message).slice(0, 90)}`);
        }
        await sleep(350);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, list.length) }, run));

    report.sort((a, b) => b.sumM - a.sumM);
    const gX = report.reduce((a, b) => a + b.sumX, 0);
    const gO = report.reduce((a, b) => a + b.sumO, 0);
    const gM = report.reduce((a, b) => a + b.sumM, 0);
    const gU = report.reduce((a, b) => a + b.sumU, 0);
    const nMiss = report.filter((r) => r.sumM > 0).length;
    const nOur = report.filter((r) => r.sumU > 0).length;
    log(`${SRC_NAME(src)}侧：xox 有我们缺 ${gM} 分（${nMiss} 人） · 我们独有 ${gU} 分（${nOur} 人，不动）`);
    if (gM > 0) {
      log('  缺口（从 xox 补）：');
      for (const r of report.filter((x) => x.sumM > 0).slice(0, 15)) {
        log(`    ${r.nick.padEnd(8, ' ')} xox ${String(r.sumX).padStart(5)} | 我们 ${String(r.sumO).padStart(5)} | 缺 ${String(r.sumM).padStart(4)}`);
      }
    }
    if (gU > 0) {
      log('  我们独有（xox 没有，保留不动）：');
      for (const r of report.filter((x) => x.sumU > 0).sort((a, b) => b.sumU - a.sumU).slice(0, 15)) {
        log(`    ${r.nick.padEnd(8, ' ')} xox ${String(r.sumX).padStart(5)} | 我们 ${String(r.sumO).padStart(5)} | 独有 ${String(r.sumU).padStart(4)}`);
      }
    }

    if (DRY) {
      log('[DRY] 不写入');
    } else if (allAdd.length) {
      const { added } = await ingest(allAdd);
      grandAddedTotal += added;
      log(`实际入库 ${added} 条`);
    }
    if (REPORT_FILE) {
      try {
        const fs = await import('node:fs/promises');
        // 两路各写一份（别互相覆盖）：xxx-live.json / xxx-room.json
        const f = REPORT_FILE.replace(/\.json$/i, '') + (src === 1 ? '-live' : '-room') + '.json';
        await fs.writeFile(f, JSON.stringify({ at: Date.now(), src, tolMinutes: TOL / 60000, report }, null, 1));
        log(`双向对账报告 → ${f}`);
      } catch (e) { log('报告写入失败：' + String(e.message).slice(0, 60)); }
    }
  }

  // 缓存落盘（含本轮成功的成员），下一轮只拉变动的
  if (!DRY) await saveCache();
  log(`\n合计实际入库 ${grandAddedTotal} 条 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
