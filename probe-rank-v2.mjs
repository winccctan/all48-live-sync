import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = (v, b) => ({ 'Content-Type': 'application/json;charset=utf-8', appInfo: mkApp(v, b), token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': `PocketFans201807/${v} (iPhone; iOS 16.3.1; Scale/2.00)` });
const post = async (p, body, v = '7.0.41', b = '24011601') => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H(v, b), body: JSON.stringify(body || {}) });
  const t = await r.text();
  return [r.status, t];
};

// A. 版本矩阵：同一个 500 接口
console.log('=== A. 版本矩阵（getPersonMeleeRankPage）');
for (const [v, b] of [['7.0.41', '24011601'], ['7.1.7', '25102901'], ['7.1.38', '25010101'], ['8.0.0', '26010101']]) {
  const [s, t] = await post('/gift/api/v1/melee/rank/getPersonMeleeRankPage', { rankId: 429, nextId: 0 }, v, b);
  console.log(` ${v.padEnd(8)} http=${s} ${t.replace(/\s+/g, ' ').slice(0, 90)}`);
  await new Promise(x => setTimeout(x, 300));
}

// B. v2 / 路径变体
console.log('=== B. 路径变体');
const paths = [
  '/gift/api/v2/melee/rank/getPersonMeleeRankPage',
  '/gift/api/v1/melee/rank/v2/getPersonMeleeRankPage',
  '/gift/api/v1/melee/rank/page/getPersonMeleeRankPage',
  '/gift/api/v1/melee/getPersonMeleeRankPage',
  '/gift/api/v1/melee/rank/getPersonMeleeRank',
  '/gift/api/v1/melee/rank/person/page',
  '/gift/api/v1/melee/rank/getMeleePersonRankPage',
];
for (const p of paths) {
  const [s, t] = await post(p, { rankId: 429, nextId: 0 });
  console.log(` ${String(s).padEnd(4)} ${p.padEnd(52)} ${t.replace(/\s+/g, ' ').slice(0, 90)}`);
  await new Promise(x => setTimeout(x, 250));
}

// C. userRole / roleId 等未试过的 key
console.log('=== C. 新参数 key');
for (const k of ['userRole', 'roleId', 'role', 'userType', 'meleeType', 'rankTypeId', 'sessionId']) {
  for (const val of [3, 1]) {
    const [s, t] = await post('/gift/api/v1/melee/rank/getPersonMeleeRankPage', { rankId: 429, nextId: 0, [k]: val });
    const ok = !t.includes('"status":500');
    console.log(`${ok ? 'OK ' : '   '} ${k}=${val}  http=${s} ${t.replace(/\s+/g, ' ').slice(0, 100)}`);
    await new Promise(x => setTimeout(x, 200));
  }
}
