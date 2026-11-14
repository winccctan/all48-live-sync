import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = () => ({ 'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' });
const post = async (p, b) => (await (await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H(), body: JSON.stringify(b || {}) })).json());
const P = '/gift/api/v1/melee/rank/';

const show = (tag, r) => {
  const c = r.content || {};
  const m = c.meleeRank || c;
  const L = m.rankUserList || [];
  const sig = L.map(x => x.rankNum + '.' + (x.baseUserInfo?.starName || '?')).join(' ');
  console.log(`${tag.padEnd(46)} st=${r.status} n=${L.length} next=${m.nextId}  ${sig.slice(0, 110)}`);
};

console.log('=== 把 nextId 系列当 rankId 传给 getMeleeWeekRank');
for (const rid of [92037, 92036, 92030, 91800, 91791, 91317, 91080]) {
  show(`getMeleeWeekRank rankId=${rid}`, await post(P + 'getMeleeWeekRank', { rankId: rid }));
  await new Promise(x => setTimeout(x, 160));
}

console.log('=== 拿本周 nextId 附近逐条试 getMeleeRankPage');
for (const rid of [92037, 92038, 92000, 91900]) {
  show(`getMeleeRankPage rankId=${rid}`, await post(P + 'getMeleeRankPage', { rankId: rid }));
  await new Promise(x => setTimeout(x, 160));
}

console.log('=== 周榜 + userId 是否返回 myself/oneself');
const t = await post(P + 'getMeleeWeekRank', { rankId: 429, userId: 614528 });
console.log('  keys:', Object.keys(t.content || {}));
console.log('  raw:', JSON.stringify(t.content || {}).slice(0, 400));
