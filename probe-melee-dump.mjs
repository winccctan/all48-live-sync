import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = { 'Content-Type': 'application/json;charset=utf-8', appInfo: mkApp('7.0.41', '24011601'), token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' };
const post = async (p, body) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  const t = await r.text();
  return [r.status, t];
};

const [s, t] = await post('/gift/api/v1/melee/rank/getMeleeRankPage', {});
console.log('http', s, 'len', t.length);
fs.writeFileSync('/tmp/melee-rankpage.json', t);
const o = JSON.parse(t);
const c = o.content || {};
console.log('content keys:', Object.keys(c));
for (const k of Object.keys(c)) {
  const v = c[k];
  console.log(`\n--- ${k}: ${Array.isArray(v) ? 'array(' + v.length + ')' : typeof v}`);
  console.log(JSON.stringify(v).slice(0, 1200));
}

const [s2, t2] = await post('/gift/api/v1/melee/rank/getMeleeWeekRank', { rankId: 429 });
console.log('\n\n===== getMeleeWeekRank rankId=429 http', s2, 'len', t2.length);
fs.writeFileSync('/tmp/melee-weekrank.json', t2);
console.log(JSON.stringify(JSON.parse(t2).content).slice(0, 2000));
