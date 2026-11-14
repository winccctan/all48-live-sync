import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = () => ({ 'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' });

const hosts = ['https://voteapi.48.cn', 'https://pocketapi.48.cn', 'https://pocketshop.48.cn'];
const paths = [
  ['/api/zx/vote/rank', { rankId: 429, nextId: 0 }],
  ['/gift/mvpRank', { nextId: 0 }],
  ['/gift/api/v1/mvpRank', { nextId: 0 }],
  ['/gift/api/v1/mvpPastRank', {}],
  ['/gift/api/v1/melee/rank/getMeleeYearRank', { rankId: 0 }],
  ['/gift/api/v1/live/getLiveRank', { liveId: 0 }],
  ['/gift/api/v1/club/home', {}],
];

for (const h of hosts) {
  for (const [p, b] of paths) {
    try {
      const r = await fetch(h + p, { method: 'POST', headers: H(), body: JSON.stringify(b) });
      const t = await r.text();
      const head = t.replace(/\s+/g, ' ').slice(0, 150);
      const notable = r.status !== 404;
      console.log(`${notable ? '★' : ' '} ${String(r.status).padEnd(4)} ${h.replace('https://', '').padEnd(20)} ${p.padEnd(42)} ${head}`);
    } catch (e) {
      console.log(`  ERR  ${h}${p} ${e.message}`);
    }
    await new Promise(x => setTimeout(x, 250));
  }
}
