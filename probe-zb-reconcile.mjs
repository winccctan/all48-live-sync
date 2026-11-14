/* zb? 口径对账：我们聚合的「场次鸡腿」vs 官方 getLiveRank 的 money 合计。
 * 关键：lv:all 的 sid 是截断 number，官方要完整 liveId ⇒ 用 gift:livecur 的完整 id 反查
 * （Number(完整id) === sid，和 perfGapReport 同一套比对方式）。 */
import fs from 'fs';
const WORKER = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/';
const SYNC = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(WORKER + '.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOK = pick('LV_TOKEN');
const BASE = 'https://all48-archive.yqz-tansy.workers.dev';
const roster = JSON.parse(fs.readFileSync('/tmp/roster.json', 'utf8'));
const byId = new Map(roster.map((m) => [String(m.id), m]));

/* 完整 liveId 表 */
const cr = await fetch(`${BASE}/api/gift/cursor`, { headers: { 'x-ingest-token': TOK } });
const cur = await cr.json();
const liveIds = Object.keys(cur.lives || {});
console.log('已知完整 liveId', liveIds.length);
const bySidNum = new Map();
for (const id of liveIds) bySidNum.set(String(Number(id)), id);

/* 流水 */
const r = await fetch(`${BASE}/api/lv/all?from=20261112&to=20261115`, { headers: { 'x-lv-token': TOK } });
const d = await r.json();
const items = (d.items || []).filter((x) => Array.isArray(x) && Number(x[7]) === 2);

const groups = new Map();
for (const x of items) {
  const k = String(x[2] ?? '');
  if (!k || k === '0') continue;
  let g = groups.get(k);
  if (!g) { g = { k, mid: String(x[1]), t0: Infinity, t1: 0, sum: 0, n: 0, senders: new Map() }; groups.set(k, g); }
  const v = (Number(x[6]) || 0) * (Number(x[5]) || 1);
  g.sum += v; g.n++;
  g.t0 = Math.min(g.t0, Number(x[0]) || Infinity);
  g.t1 = Math.max(g.t1, Number(x[0]) || 0);
  g.senders.set(String(x[3] || ''), (g.senders.get(String(x[3] || '')) || 0) + v);
}

/* 官方接口 */
const NIM = fs.readFileSync(SYNC + 'nim-sync.env', 'utf8');
const pickN = (k) => { const m = NIM.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const { generatePa } = await import(SYNC + 'nim-client/pa.mjs');
const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = { 'Content-Type': 'application/json;charset=utf-8', appInfo: mkApp('7.0.41', '24011601'), token: pickN('POCKET48_TOKEN'), pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' };

const cands = [...groups.values()]
  .filter((g) => bySidNum.has(g.k))
  .sort((a, b) => b.t1 - a.t1)
  .slice(0, 8);
console.log(`能对上完整 id 的场次 ${[...groups.values()].filter((g) => bySidNum.has(g.k)).length} / ${groups.size}，抽查 ${cands.length} 场\n`);

for (const g of cands) {
  const full = bySidNum.get(g.k);
  let off = null;
  try {
    const rr = await fetch('https://pocketapi.48.cn/live/api/v1/live/getLiveRank', {
      method: 'POST', headers: H,
      body: JSON.stringify({ liveId: String(full), type: '1', page: 1, limit: 100 }),
    });
    const t = await rr.text();
    const o = JSON.parse(t);
    const c = o.content || {};
    const list = c.rankList || c.list || c.rankUserList || [];
    off = {
      st: o.status,
      keys: Object.keys(c).join(','),
      n: list.length,
      money: list.reduce((a, x) => a + (Number(x.money ?? x.melee ?? x.amount ?? 0) || 0), 0),
      sample: list[0] ? JSON.stringify(list[0]).slice(0, 160) : '',
    };
  } catch (e) { off = { err: String(e.message).slice(0, 60) }; }
  const nm = (byId.get(g.mid) || {}).n || g.mid;
  console.log(`场次 ${full}  ${nm}  我们=${g.sum.toLocaleString()} (${g.n}笔)`);
  console.log(`   官方: ${JSON.stringify(off)}`);
  await new Promise((x) => setTimeout(x, 600));
}
