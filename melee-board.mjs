// 口袋48「鸡腿榜」全团重建（官方口径校准）
//
// 背景（详见 output/fp-archive-2025/melee-api.md）：
//   · `getMeleeWeekRank` 只给 TOP7，服务端硬截断，`nextId` 是死参数（穷尽验证过）
//   · `getPersonMeleeRankPage {resId}` 给「单成员 TOP16 金主」，**含翻牌**，是我们唯一能拿到的
//     官方逐人贡献口径；但它只有 16 条，也没有成员自己的合计
//   ⇒ 官方「全团榜」不存在，只能自建。自建的唯一口径是礼物流（房间+直播+公演），
//     缺 20~50% 的翻牌（每个成员差得还不一样，所以**光按礼物流排名会错**）。
//
// 本脚本干三件事：
//   ① 拉官方：本周 TOP7 精确值 + 每个成员的 TOP16 金主（官方数据，含翻牌）
//   ② 算我们：该周 7 天的 lv:all 礼物流合计，以及「这 16 个金主」在我们这边的礼物流合计
//   ③ 校准：段覆盖率 = 我们的16人礼物流 / 官方的16人合计，用它把「我们的总额」反推成官方口径
//      回测（本周 TOP7）：柏欣妤 +0.4% / 林舒晴 +2.3% / 曾昕妍 +3.6% / 蒋欣洳 +4.2%，
//      杨冰怡 −12% / 钟郭菲杨 +15%（这两人非头部粉丝的翻牌占比和头部不同）
//      ⇒ 榜单主排序列「推算」并标注误差，同时把「我们的礼物流」原值一起给出，可自行核对
//
// 用法：
//   node melee-board.mjs             # 抓最新结算周 + 落库
//   node melee-board.mjs 428         # 指定期号（历史期拿不到当时的 TOP16，只能补 TOP7）
//   node melee-board.mjs --dry       # 只打印不写入
import { readFileSync } from 'node:fs';
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN;
const SITE = process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev';
const INGEST = process.env.INGEST_TOKEN;

const R = '/gift/api/v1/melee/rank';
const call = (p, b) => postJson(p, b, { token: TOKEN, retries: 2 });

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const WANT_ID = Number(argv.find((a) => /^\d+$/.test(a))) || 0;

/* ---------------- 名册 ---------------- */
function loadRoster() {
  const src = readFileSync('../all48-worker/public/data/members.js', 'utf8');
  const json = src.replace(/^\s*window\.MEMBERS\s*=\s*/, '').replace(/;\s*$/, '');
  const list = JSON.parse(json);
  const m = new Map();
  for (const x of list) m.set(Number(x.id), { n: x.n, g: x.g, tm: x.tm });
  return m;
}

const pad = (n) => String(n).padStart(2, '0');

/** "11月02日-11月08日" + 期号 → 起止 yyyymmdd（年份按「不晚于今天」推断） */
function weekRange(label, rankId) {
  const m = /(\d{1,2})月(\d{1,2})日\s*-\s*(\d{1,2})月(\d{1,2})日/.exec(String(label || ''));
  if (!m) return null;
  const [, m1, d1, m2, d2] = m.map(Number);
  const now = new Date(Date.now() + 8 * 3600e3);
  let y = now.getUTCFullYear();
  // 12 月底看到「01月」的期 ⇒ 是去年的
  if (m1 > now.getUTCMonth() + 3) y -= 1;
  const from = `${y}${pad(m1)}${pad(d1)}`;
  const to = `${y}${pad(m2)}${pad(d2)}`;
  return { from, to, y };
}

function daysBetween(from, to) {
  const out = [];
  const a = Date.parse(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}T00:00:00+08:00`);
  const b = Date.parse(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6)}T00:00:00+08:00`);
  for (let t = a; t <= b; t += 86400e3) {
    const d = new Date(t + 8 * 3600e3);
    out.push(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`);
  }
  return out;
}

/* ---------------- 我们的礼物流（lv:all） ---------------- */
async function fetchLvDay(day, lvToken) {
  const r = await fetch(`${SITE}/api/lv/all?day=${day}`, { headers: { 'x-lv-token': lvToken } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const items = (j && (j.items || (j.content && j.content.items))) || null;
  return Array.isArray(items) ? items : null;
}

function aggregate(rows) {
  const per = new Map();          // mid -> 鸡腿
  const perFan = new Map();       // mid -> Map(nick -> 鸡腿)
  let n = 0;
  for (const r of rows) {
    const mid = Number(r[1]) || 0;
    if (!mid) continue;
    const val = (Number(r[5]) || 0) * (Number(r[6]) || 0);
    if (!val) continue;
    n++;
    per.set(mid, (per.get(mid) || 0) + val);
    const nick = String(r[3] || '');
    let f = perFan.get(mid);
    if (!f) { f = new Map(); perFan.set(mid, f); }
    f.set(nick, (f.get(nick) || 0) + val);
  }
  return { per, perFan, rows: n };
}

/* ---------------- 官方 ---------------- */
async function officialIndex() {
  const r = await call(`${R}/getMeleeRankPage`, { rankid: 0 });
  const list = (r.content && r.content.weekRankList) || [];
  return list.map((w) => ({ id: Number(w.weekRankId), label: String(w.weekRankName || '') }));
}

async function officialWeek(rankId) {
  const r = await call(`${R}/getMeleeWeekRank`, { rankId });
  return ((r.content && r.content.rankUserList) || []).map((x) => ({
    rank: Number(x.rankNum) || 0,
    melee: Number(x.melee) || 0,
    id: Number(x.baseUserInfo && x.baseUserInfo.userId) || 0,
    name: String((x.baseUserInfo && (x.baseUserInfo.starName || x.baseUserInfo.nickname)) || ''),
  }));
}

async function officialFans(memberId) {
  const r = await call(`${R}/getPersonMeleeRankPage`, { resId: memberId });
  const list = (r.content && r.content.charmInfo) || [];
  return list.map((x) => ({
    n: x.privacy ? '匿名用户' : String((x.userInfo && x.userInfo.nickname) || ''),
    c: Number(x.totalCharm) || 0,
    p: x.privacy ? 1 : 0,
  }));
}

/* ---------------- 主流程 ---------------- */
const lvToken = (() => {
  if (process.env.LV_TOKEN) return process.env.LV_TOKEN;
  try {
    const txt = readFileSync('../all48-worker/.env', 'utf8');
    const m = /^LV_TOKEN=(.*)$/m.exec(txt);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
})();

const roster = loadRoster();
const weeks = await officialIndex();
if (!weeks.length) { console.error('拿不到周榜索引'); process.exit(1); }
const target = WANT_ID ? weeks.find((w) => w.id === WANT_ID) || { id: WANT_ID, label: '' } : weeks[0];
const range = weekRange(target.label, target.id);
if (!range) { console.error('周区间解析失败: ' + target.label); process.exit(1); }
console.log(`期号 ${target.id}  ${target.label}  → ${range.from}..${range.to}`);

const top7 = await officialWeek(target.id);
console.log(`官方 TOP7: ${top7.map((x) => `${x.name}=${x.melee}`).join('  ')}`);

const days = daysBetween(range.from, range.to);
const rows = [];
for (const d of days) {
  const items = await fetchLvDay(d, lvToken);
  if (!items) { console.warn(`  缺 ${d}`); continue; }
  rows.push(...items);
}
const agg = aggregate(rows);
console.log(`我们: ${days.length} 天 / ${agg.rows} 笔礼物 / ${agg.per.size} 名成员`);

const ids = new Set([...agg.per.keys(), ...top7.map((x) => x.id)]);
const offById = new Map(top7.map((x) => [x.id, x]));

const out = [];
const fansOut = {};
let i = 0;
for (const id of ids) {
  i++;
  if (i % 25 === 0) console.log(`  …${i}/${ids.size}`);
  const our = agg.per.get(id) || 0;
  const meta = roster.get(id) || {};
  const offRow = offById.get(id) || null;
  let fans = [];
  try { fans = await officialFans(id); } catch (e) { fans = []; }
  const f16 = fans.reduce((a, x) => a + x.c, 0);
  const fanMap = agg.perFan.get(id) || new Map();
  const g16 = fans.reduce((a, x) => a + (fanMap.get(x.n) || 0), 0);
  const cov = f16 > 0 ? g16 / f16 : 0;
  // 段覆盖率太低（<15%）说明这 16 个金主的钱几乎全走翻牌/私密，反推进会炸，直接不推
  const est = cov >= 0.15 ? Math.round(our / cov) : our;
  out.push({
    id,
    n: meta.n || (offRow && offRow.name) || String(id),
    g: meta.g || '',
    tm: meta.tm || '',
    our,
    off: offRow ? offRow.melee : null,
    est,
    f16,
    g16,
    cov: Math.round(cov * 1000) / 1000,
    fans: fans.length,
  });
  if (fans.length) fansOut[id] = fans.map((x) => [x.n, x.c, x.p]);
  await new Promise((s) => setTimeout(s, 180));
}

/* 🔴 排序口径：用「我们实测的礼物流」，不排 est。
 *
 *   为什么不用 est（按官方 TOP16 段覆盖率反推）：回测里朱怡欣 est 误差 +96.9%
 *   —— 她的 TOP1 是个 privacy:1 的匿名用户（130,345 鸡腿），我们这边按昵称根本
 *   对不上，cov 被算成 0.53，一除就把 537,938 放大成 1,006,607。
 *   匿名金主越多的人，est 越不可靠，而头部成员恰好匿名最多 ⇒ 推算排序会翻车。
 *
 *   ⇒ 主排序 = our（硬数据，可逐笔核对）；est 只作为「参考上限」展示，不参与排名。
 *   cov 同步给出，用户能一眼看出这人的粉丝里「礼物流可见」的比例。 */
out.sort((a, b) => b.our - a.our);
out.forEach((x, idx) => { x.rank = idx + 1; });

/* 自检：我们 vs 官方的偏差（官方 TOP7 才有） */
console.log('\n回测（官方 TOP7）：');
for (const x of out) {
  if (x.off == null) continue;
  const err = ((x.our - x.off) / x.off) * 100;
  console.log(`  #${String(x.rank).padStart(2)} ${x.n.padEnd(7)} 官方=${String(x.off).padStart(8)} 我们=${String(x.our).padStart(8)} 偏差=${err >= 0 ? '+' : ''}${err.toFixed(1)}%  段覆盖=${(x.cov * 100).toFixed(0)}%`);
}

const payload = {
  v: 1,
  rankId: target.id,
  weekLabel: target.label,
  from: range.from,
  to: range.to,
  builtAt: Date.now(),
  officialTop: top7,
  // 每行带 TA 的官方 TOP3 金主（含翻牌，官方口径）—— 这是官方 TOP16 里最有信息量的摘要
  rows: out.map((x) => ({ ...x, fans: (fansOut[x.id] || []).slice(0, 3) })),
};
const buf = Buffer.from(JSON.stringify(payload));
console.log(`\npayload ${(buf.length / 1024).toFixed(0)} KB（gzip 后约 ${(buf.length / 1024 / 4).toFixed(0)} KB）`);

if (DRY) {
  console.log('--dry，不写入');
} else {
  const r = await fetch(`${SITE}/api/melee/board`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST },
    body: buf,
  });
  console.log('写入:', r.status, (await r.text()).slice(0, 300));
}
