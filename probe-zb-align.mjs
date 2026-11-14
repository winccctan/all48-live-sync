/* 逐人对齐：官方 getLiveRank（送礼人榜，20 人）vs 我方按昵称聚合的场次明细。
 * 目的：判断差额是「单位不同（元/鸡腿）」还是「我们漏采」。 */
import fs from 'fs';
const WORKER = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/';
const SYNC = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(WORKER + '.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOK = pick('LV_TOKEN');
const BASE = 'https://all48-archive.yqz-tansy.workers.dev';
const NIM = fs.readFileSync(SYNC + 'nim-sync.env', 'utf8');
const pickN = (k) => { const m = NIM.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const { generatePa } = await import(SYNC + 'nim-client/pa.mjs');
const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = { 'Content-Type': 'application/json;charset=utf-8', appInfo: mkApp('7.0.41', '24011601'), token: pickN('POCKET48_TOKEN'), pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' };

const liveId = process.argv[2] || '1328468207704281088';
const r = await fetch(`${BASE}/api/lv/all?from=20261112&to=20261115`, { headers: { 'x-lv-token': TOK } });
const d = await r.json();
const sidNum = String(Number(liveId));
const rows = (d.items || []).filter((x) => Array.isArray(x) && Number(x[7]) === 2 && String(x[2]) === sidNum);
console.log(`场次 ${liveId}  我方行 ${rows.length}`);

const mine = new Map();
for (const x of rows) {
  const sn = String(x[3] || '');
  const v = (Number(x[6]) || 0) * (Number(x[5]) || 1);
  if (!mine.has(sn)) mine.set(sn, { v: 0, n: 0, gifts: new Map() });
  const g = mine.get(sn);
  g.v += v; g.n += 1;
  const gn = String(x[4] || '');
  g.gifts.set(gn, (g.gifts.get(gn) || 0) + v);
}
const mineSum = [...mine.values()].reduce((a, x) => a + x.v, 0);
console.log('我方合计', mineSum, '人数', mine.size);

const rr = await fetch('https://pocketapi.48.cn/live/api/v1/live/getLiveRank', { method: 'POST', headers: H, body: JSON.stringify({ liveId: String(liveId), type: '1', page: 1, limit: 100 }) });
const o = JSON.parse(await rr.text());
const off = o.content || [];
const offSum = off.reduce((a, x) => a + (Number(x.money) || 0), 0);
console.log('官方 20 人合计', offSum, '人数', off.length);

const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
const mineByNorm = new Map([...mine.entries()].map(([k, v]) => [norm(k), { k, ...v }]));
console.log('\n昵称                 官方money   我方v      倍率   我方礼物');
for (const x of off) {
  const nm = x.user && x.user.userName;
  const m = mineByNorm.get(norm(nm));
  const ratio = m && m.v ? (Number(x.money) / m.v).toFixed(2) : '-';
  const gifts = m ? [...m.gifts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g, v]) => g + ':' + v).join(' ') : '（我方无此人）';
  console.log(`${String(nm).slice(0, 16).padEnd(18)} ${String(x.money).padEnd(11)} ${String(m ? m.v : 0).padEnd(9)} ${String(ratio).padEnd(6)} ${gifts}`);
}
console.log('\n我方有、官方前 20 没有的人:');
for (const [k, v] of [...mine.entries()].filter(([k]) => !off.some((x) => norm(x.user && x.user.userName) === norm(k)))) {
  console.log(`  ${k} ${v.v}`);
}
