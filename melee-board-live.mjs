// 本周「进行中」鸡腿榜：从 lv:all 流水实时聚合 → 写入 melee:board
// 与 melee-board.mjs 的区别：那个是「官方已结算周 + TOP16 校准」，
// 这个是「本周至今、纯我方礼物流」，用来让页面在周中也有数看。
import { readFileSync } from 'node:fs';

const SITE = process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev';
const TOKEN = process.env.LV_TOKEN || process.env.INGEST_TOKEN;
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/';

/** 北京日期 yyyymmdd 加减 */
function bjAdd(day, n) {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)) + n * 86400000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
function bjToday() {
  const t = Date.now() + 8 * 3600 * 1000;
  return new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
}
/** 本周一（北京） */
function mondayOf(day) {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)));
  const wd = d.getUTCDay(); // 0=周日
  const back = wd === 0 ? 6 : wd - 1;
  return bjAdd(day, -back);
}

const today = bjToday();
const from = mondayOf(today);
const to = bjAdd(from, 6);
console.log('本周', from, '->', to, '（今天', today, '）');

// 1. 拉流水
const u = SITE + '/api/lv/all?from=' + from + '&to=' + today;
const r = await fetch(u, { headers: { 'x-lv-token': TOKEN } });
if (!r.ok) { console.error('拉流水失败', r.status); process.exit(1); }
const j = await r.json();
const items = j.items || [];
console.log('流水', items.length, '条 |', JSON.stringify(j.days));

// 2. 聚合（行结构 [t,mid,sid,sn,g,num,v,room,ch]）
const agg = new Map();
for (const row of items) {
  const sid = Number(row[2]) || 0;
  if (!sid) continue;
  const num = Number(row[5]) || 0;
  const v = Number(row[6]) || 0;
  const leg = num * v;
  if (!leg) continue;
  agg.set(sid, (agg.get(sid) || 0) + leg);
}
console.log('有礼物的成员', agg.size);

// 3. 名册
const src = readFileSync(ROOT + 'all48-worker/public/data/members.js', 'utf8');
const roster = JSON.parse(src.replace(/^\s*window\.MEMBERS\s*=\s*/, '').replace(/;\s*$/, ''));
const byId = new Map(roster.map((x) => [Number(x.id), x]));

const rows = [];
let unknown = 0;
for (const [sid, leg] of agg) {
  const m = byId.get(Number(sid));
  if (!m) { unknown++; continue; }
  rows.push({ id: sid, n: m.n, g: m.g, tm: m.tm, our: leg, off: null, est: leg, cov: 1 });
}
rows.sort((a, b) => b.our - a.our);
console.log('入榜', rows.length, '| 名册外忽略', unknown);
console.log(rows.slice(0, 6).map((x) => `${x.n} ${x.our}`).join(' | '));

if (process.argv.includes('--dry')) process.exit(0);

// 4. 写入
const payload = {
  rankId: Number(process.env.WEEK_ID || 0) || undefined,
  w: Number(process.env.WEEK_ID || 0) || undefined,
  weekLabel: from.slice(4, 6) + '月' + from.slice(6, 8) + '日-' + to.slice(4, 6) + '月' + to.slice(6, 8) + '日',
  from, to,
  builtAt: Date.now(),
  rows,
};
const post = async (body) => {
  const res = await fetch(SITE + '/api/melee/board', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lv-token': TOKEN },
    body: JSON.stringify(body),
  });
  return [res.status, await res.text()];
};
const [sc, txt] = await post(payload);
console.log('写入', sc, txt.slice(0, 160));
if (sc !== 200 || !/"ok":true/.test(txt)) process.exit(1);
