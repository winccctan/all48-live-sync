/* zb? 原型：按场次聚合 lv:all 的直播礼物，输出某成员最近 N 场。
 * 口径：场次键 = String(sid)（number 截断，但不同场次差在千位以上，唯一性够）；
 *       成员 = 该场次行的 mid（每场只属于一个人）；总鸡腿 = Σ v*num。 */
import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/';
const env = fs.readFileSync(ROOT + '.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOK = pick('LV_TOKEN') || pick('WX_QUEUE_TOKEN');
const BASE = 'https://all48-archive.yqz-tansy.workers.dev';

const roster = JSON.parse(fs.readFileSync('/tmp/roster.json', 'utf8').toString());
const byId = new Map(roster.map((m) => [String(m.id), m]));

const from = process.argv[2] || '20261112';
const to = process.argv[3] || '20261115';
const who = Number(process.argv[4] || 89653517);

const r = await fetch(`${BASE}/api/lv/all?from=${from}&to=${to}`, { headers: { 'x-lv-token': TOK } });
const d = await r.json();
const items = (d.items || []).filter((x) => Array.isArray(x) && Number(x[7]) === 2);
console.log('直播行', items.length);

const groups = new Map();
for (const x of items) {
  const k = String(x[2] ?? '');
  if (!k || k === '0') continue;
  let g = groups.get(k);
  if (!g) { g = { k, mid: String(x[1]), t0: Infinity, t1: 0, sum: 0, n: 0, senders: new Map(), gifts: new Map() }; groups.set(k, g); }
  const v = (Number(x[6]) || 0) * (Number(x[5]) || 1);
  g.sum += v; g.n++;
  g.t0 = Math.min(g.t0, Number(x[0]) || Infinity);
  g.t1 = Math.max(g.t1, Number(x[0]) || 0);
  const sn = String(x[3] || '');
  g.senders.set(sn, (g.senders.get(sn) || 0) + v);
  const gn = String(x[4] || '');
  g.gifts.set(gn, (g.gifts.get(gn) || 0) + v);
}
const all = [...groups.values()];
const mine = all.filter((g) => g.mid === String(who)).sort((a, b) => b.t1 - a.t1);
console.log(`\n${(byId.get(String(who)) || {}).n || who} 的场次：${mine.length} 场`);
const t = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
mine.slice(0, 3).forEach((g, i) => {
  console.log(`\n#${i + 1}  ${t(g.t0)} ~ ${t(g.t1)}  鸡腿 ${g.sum.toLocaleString()}  ${g.n} 笔  ${g.senders.size} 人送`);
  const top = [...g.senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('   ' + top.map(([n, v]) => `${n} ${v.toLocaleString()}`).join(' · '));
  const gtop = [...g.gifts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log('   礼物: ' + gtop.map(([n, v]) => `${n} ${v.toLocaleString()}`).join(' · '));
});

/* 队/团维度 */
const teamQ = (m) => {
  const x = byId.get(String(m));
  return x ? (x.tm || '').replace(/^TEAM\s+/, '') : '';
};
const groupQ = (m) => (byId.get(String(m)) || {}).g || '';
const sumOf = (f) => {
  const hit = all.filter((g) => f(g.mid));
  return { n: hit.length, sum: hit.reduce((a, g) => a + g.sum, 0), members: new Set(hit.map((g) => g.mid)).size };
};
const last24 = Date.now() - 86400e3;
console.log('\n=== 维度汇总（近 ' + from + '~' + to + '）===');
for (const [label, f] of [
  ['NIII', (m) => teamQ(m) === 'NIII'],
  ['GNZ', (m) => groupQ(m) === 'GNZ48'],
  ['group', () => true],
]) {
  const s = sumOf(f);
  console.log(`${label.padEnd(6)} 场次 ${String(s.n).padEnd(4)} 人 ${String(s.members).padEnd(4)} 鸡腿 ${s.sum.toLocaleString()}`);
}
