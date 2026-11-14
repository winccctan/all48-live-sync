/* 摸清 lv:all 里「直播场次」的真实形态：sid 是否字符串/截断、ch 里 liveId 是否完整、mid 是否带成员。 */
import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/';
const env = fs.readFileSync(ROOT + '.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOK = pick('LV_TOKEN') || pick('WX_QUEUE_TOKEN');
const BASE = 'https://all48-archive.yqz-tansy.workers.dev';

const r = await fetch(`${BASE}/api/lv/all?from=20261112&to=20261115`, { headers: { 'x-lv-token': TOK } });
const d = await r.json();
const items = d.items || [];
console.log('行数', items.length, 'days', d.days);
const live = items.filter((x) => Array.isArray(x) && Number(x[7]) === 2);
console.log('直播行', live.length);
console.log('\n样本（前 3 条直播行）：');
live.slice(0, 3).forEach((x) => console.log('  ', JSON.stringify(x)));

const sidTypes = {};
for (const x of live) {
  const t = typeof x[2];
  sidTypes[t] = (sidTypes[t] || 0) + 1;
}
console.log('\nsid 类型分布:', sidTypes);

/* 场次键提取：ch 里的 live:<id> 优先 */
const keyOf = (x) => {
  const ch = String(x[8] || '');
  const m = /live:(\d{10,20})/.exec(ch);
  if (m) return m[1];
  const s = String(x[2] ?? '');
  return s && s !== '0' ? s : '';
};
const groups = new Map();
for (const x of live) {
  const k = keyOf(x);
  if (!k) continue;
  if (!groups.has(k)) groups.set(k, { k, n: 0, sum: 0, mids: new Map(), first: Infinity, last: 0, chs: new Set(), sids: new Set() });
  const g = groups.get(k);
  g.n++;
  g.sum += (Number(x[6]) || 0) * (Number(x[5]) || 1);
  const mid = String(x[1]);
  g.mids.set(mid, (g.mids.get(mid) || 0) + 1);
  g.first = Math.min(g.first, Number(x[0]) || Infinity);
  g.last = Math.max(g.last, Number(x[0]) || 0);
  g.chs.add(String(x[8] || ''));
  g.sids.add(String(x[2]));
}
const arr = [...groups.values()].sort((a, b) => b.last - a.last);
console.log('\n场次数', arr.length);
for (const g of arr.slice(0, 6)) {
  const topMid = [...g.mids.entries()].sort((a, b) => b[1] - a[1])[0];
  const t = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
  console.log(`  场次 ${g.k.slice(0, 20).padEnd(20)} 行=${String(g.n).padEnd(5)} 鸡腿=${String(g.sum).padEnd(8)} mid=${topMid[0]}(${topMid[1]}) ${t(g.first)}~${t(g.last)}  sid数=${g.sids.size} ch=[${[...g.chs].slice(0, 2).join(',')}]`);
}
