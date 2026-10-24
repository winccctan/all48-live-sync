#!/usr/bin/env node
/**
 * 成员发现（「站上缺人」的自动补洞通道）
 * =====================================================================
 * 站长 2026-10-25：「这里的成员也要补齐呀」「新成员有办法实时补吗」「或者成员队伍变化」
 *
 * 名册（public/data/members.js）是某一次抓下来的静态快照，
 * 而运营随时补新人（BEJ48 B 预备生刘卓尔 / 张旭、CGT48 陈雪妍…）。
 * gnz 榜单只能补「当天有分」的人，刚加入还没人送礼的新人完全查不到。
 *
 * 但**新人一定会开播**。所以这条通道从「直播历史」里反查：
 *   ① 翻 getLiveList（record:true）最近 N 天 → userInfo.{userId, starName}
 *   ② 跟站点名册比，谁不在名单里就是新人
 *   ③ im/server/jump 拿她**当前**的 serverId / channelId（房间唯一权威源）
 *   ④ 团/队取官方全团表（h5.48.cn，移籍当天更新；官方没收录就留空，绝不瞎猜）
 *   ⑤ POST /api/roster/extra 推上去
 *
 * 🔴 为什么推 KV 而不是改静态文件：
 *   所有48-worker 不是 git 仓库（wrangler 直接部署），Actions 里改不了静态文件；
 *   而 worker 的 `/data/members.js` 已经是「静态 + 官方表 + roster:extra」动态拼的
 *   ⇒ 推进 KV 后，**页面成员列表和抓取端扫描列表同时生效**，下一轮就扫到她的房间。
 *
 * 🔴 只增不改：已有成员一律不动（站长：「我们是对的」）。这里只处理名册里
 *   **完全没有的 userId**，连名字都不改。
 *
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN  同其他抓取脚本
 *   PAGES    最多往回翻几页（每页 20 条，默认 120）
 *   DAYS     只关心最近几天开播过的人（默认 30）
 *   DRY=1    只打印不提交
 */
import { fetchLiveListPage, fetchNewestLiveId, postJson } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || 'https://all48.wyc0518.cc').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const PAGES = Math.max(1, Number(process.env.PAGES || 120));
const DAYS = Math.max(1, Number(process.env.DAYS || 30));
const DRY = !!process.env.DRY;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BJ = 8 * 3600 * 1000;
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().replace('T', ' ').slice(0, 19), ...a);

const GROUP_MAP = { SNH: 'SNH48', GNZ: 'GNZ48', BEJ: 'BEJ48', CKG: 'CKG48', CGT: 'CGT48', IDFT: 'IDFT' };
const TEAM_SET = new Set(['SII', 'NII', 'HII', 'X', 'XII', 'G', 'NIII', 'Z', 'B', 'E', 'J',
  'C', 'K', 'CII', 'GII', 'SIII', 'HIII', 'Ft']);

/** 与 sync-roster.mjs / xox-live-backfill.mjs 完全一致的站内队名写法 */
function mapTeam(gname, tname) {
  const t = String(tname || '').trim();
  if (!t) return '';
  if (t === '荣誉毕业生') return '荣誉毕业生';
  if (/预备生$/.test(t)) return '预备生';
  if (t.toLowerCase() === 'idft') return 'IDFT';
  if (TEAM_SET.has(t)) return 'TEAM ' + t;
  return t;
}
const fuzzNick = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
/** "BEJ48-刘卓尔" → "刘卓尔"；"SNH48-段艺璇" → "段艺璇" */
const bareName = (s) => String(s || '').replace(/^[A-Za-z0-9]+48[-_－]\s*/, '').trim();

/* ---------------------------------------------- ① 站点现有名册 */
let roster = new Map();      // uid → {n, srv, ch}
let nameSet = new Set();
try {
  const r = await fetch(SITE + '/data/members.js?v=' + Date.now(), { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const txt = await r.text();
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  for (const m of arr) {
    if (!m || m.id == null) continue;
    roster.set(Number(m.id), m);
    if (m.n) nameSet.add(fuzzNick(m.n));
  }
  log(`站点名册 ${roster.size} 人`);
} catch (e) {
  log('读站点名册失败：' + String(e.message).slice(0, 90));
  process.exit(1);
}

/* ---------------------------------------------- ② 翻直播历史找陌生主播 */
const since = Date.now() - DAYS * 86400000;
let next = await fetchNewestLiveId({ groupId: 0, record: true });
const strangers = new Map();     // uid → {name, nick, last}
let pages = 0, seen = 0;
const t0 = Date.now();
for (let p = 0; p < PAGES; p++) {
  let r;
  try { r = await fetchLiveListPage({ groupId: 0, next, record: true }); }
  catch (e) { log('第 ' + (p + 1) + ' 页失败：' + String(e.message).slice(0, 70)); break; }
  const list = r.list || [];
  if (!list.length) break;
  pages++;
  for (const x of list) {
    const u = x.userInfo || {};
    const uid = Number(u.userId) || 0;
    if (!uid) continue;
    seen++;
    const nm = bareName(u.starName || u.nickname || '');
    if (!nm) continue;
    if (roster.has(uid) || nameSet.has(fuzzNick(nm))) continue;   // 名单里有这个人 ⇒ 跳过
    const old = strangers.get(uid);
    const ct = Number(x.ctime) || 0;
    if (!old || ct > old.last) strangers.set(uid, { name: nm, nick: String(u.nickname || ''), last: ct });
  }
  const oldest = Number(list[list.length - 1].ctime) || 0;
  if (oldest && oldest < since) break;
  if (!r.next || String(r.next) === '0' || String(r.next) === String(next)) break;
  next = r.next;
}
log(`翻 ${pages} 页 / ${seen} 条直播记录 · 名册外的主播 ${strangers.size} 人（耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);

/* ---------------------------------------------- ②b 名册里有、但没有房间的人
   典型来源：xox48 对账只补了名字（它只有 uid → 名字/团/队，没有房间号），
   于是人上了榜但抓取端扫不到她的房间 —— 表现为「榜上有名字、点进去啥也没有」。
   这些人一旦开播过、或本来就该有房间，jump 一次就能拿到 serverId/channelId。
   每轮最多补 12 个（低频、量小，不会给口袋48 加压）。 */
const KEEP_TM = new Set(['荣誉毕业生']);
const KEEP_G = new Set(['明星殿堂', '丝芭影视', '燃烧吧团魂']);
const noRoom = [];
for (const m of roster.values()) {
  if (!m || !m.id || (m.srv && m.ch)) continue;
  if (KEEP_TM.has(String(m.tm || '')) || KEEP_G.has(String(m.g || ''))) continue;
  if (!m.n) continue;
  noRoom.push({ uid: Number(m.id), name: String(m.n), nick: '', last: 0, g: m.g || '', tm: m.tm || '', isNew: false });
}
if (noRoom.length) log(`名册内「无房间」${noRoom.length} 人（本轮最多补 ${Math.min(12, noRoom.length)} 个）`);
const EMPTY_MAX = 12;

if (!strangers.size && !noRoom.length) { log('新人 0 · 无房间 0，收工'); process.exit(0); }

/* ---------------------------------------------- ③ 官方全团表（团/队权威源） */
let official = null;
try {
  const r = await fetch('https://h5.48.cn/resource/json/allmembers_0.jsonp', { headers: { 'user-agent': 'Mozilla/5.0' } });
  const txt = await r.text();
  const rows = JSON.parse(txt.slice(txt.indexOf('(') + 1, txt.lastIndexOf(')'))).rows || [];
  if (rows.length < 500) throw new Error('行数异常 ' + rows.length);
  official = new Map();
  for (const x of rows) {
    const k = fuzzNick(x.sname);
    if (!k) continue;
    const a = official.get(k);
    if (a) a.push(x); else official.set(k, [x]);
  }
  log(`官方全团表 ${rows.length} 人`);
} catch (e) {
  log('官方表取不到（团队留空，不猜）：' + String(e.message).slice(0, 70));
}

/* ---------------------------------------------- ④ jump 拿当前房间 */
if (!TOKEN && !DRY) { log('缺少 POCKET48_TOKEN，无法核对房间；名册仍会补上名字（房间为 0）'); }
const todo = [];
let i = 0;
const arr = [
  ...[...strangers.entries()].map(([uid, info]) => ({ uid, ...info, isNew: true })),
  ...noRoom.slice(0, EMPTY_MAX),
];
async function worker() {
  for (;;) {
    const idx = i++;
    if (idx >= arr.length) return;
    const t = arr[idx];
    const info = t;
    let srv = 0, ch = 0;
    if (TOKEN) {
      try {
        const j = await postJson('/im/api/v1/im/server/jump', { tabId: 0, targetType: 1, starId: t.uid }, { token: TOKEN, retries: 2 });
        const c = j.content || {};
        srv = Number(c.serverId) || 0;
        ch = Number(c.channelId) || 0;
      } catch (e) {
        log(`  ${info.name} jump 失败：${String(e.message).slice(0, 60)}`);
      }
    }
    // 已有成员只补房间，团/队一个字都不动（站长：「我们是对的」）
    let g = t.g || '', tm = t.tm || '';
    if (t.isNew) {
      const hit = official && official.get(fuzzNick(info.name));
      if (hit && hit.length === 1) {
        g = GROUP_MAP[String(hit[0].gname || '').trim().toUpperCase()] || '';
        tm = mapTeam(hit[0].gname, hit[0].tname);
      }
      // 官方表没收录 → 团从昵称前缀猜（BEJ48-xx），队留空
      if (!g) {
        const m = /^([A-Z]+48)-/.exec(String(info.nick || ''));
        if (m) g = GROUP_MAP[m[1].slice(0, 3)] || m[1];
      }
    }
    const tag = t.isNew ? '+' : '⟳';
    const when = info.last ? '  最后播 ' + new Date(info.last + BJ).toISOString().slice(0, 16).replace('T', ' ') : '';
    todo.push([t.uid, info.name, g, tm, null, srv, ch]);
    log(`  ${tag} ${info.name}  uid=${t.uid}  ${g}/${tm || '（队未知）'}  srv=${srv} ch=${ch}${when}`);
  }
}
await Promise.all(Array.from({ length: Math.min(4, arr.length) }, worker));

if (DRY) {
  log('[DRY] 不上报：' + JSON.stringify(todo.slice(0, 8)));
  process.exit(0);
}
if (!INGEST) { log('缺少 INGEST_TOKEN，无法写入名册'); process.exit(1); }

/* ---------------------------------------------- ⑤ 推补充名册 */
try {
  const r = await fetch(SITE + '/api/roster/extra', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST, 'user-agent': UA },
    body: JSON.stringify({ rows: todo }),
  });
  const j = await r.json().catch(() => ({}));
  log('名册写入：' + JSON.stringify(j).slice(0, 200));
} catch (e) {
  log('名册写入失败：' + String(e.message).slice(0, 110));
  process.exitCode = 1;
}
