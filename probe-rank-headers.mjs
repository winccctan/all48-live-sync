import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });

const base = { 'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' };

const variants = [
  ['plain', {}],
  ['P-Sign-Type', { 'P-Sign-Type': 'V0' }],
  ['sign+XRW', { 'P-Sign-Type': 'V0', 'X-Requested-With': 'com.pocket.snh48' }],
  ['sign+ref', { 'P-Sign-Type': 'V0', Referer: 'https://pocketapi.48.cn/' }],
  ['sign+ver', { 'P-Sign-Type': 'V0', version: '7.0.41', plat: 'ios' }],
  ['all', { 'P-Sign-Type': 'V0', 'X-Requested-With': 'com.pocket.snh48', Referer: 'https://pocketapi.48.cn/', version: '7.0.41', plat: 'ios' }],
];

const P = '/gift/api/v1/melee/rank/';
for (const ep of ['getPersonMeleeRankPage', 'getClubMeleeRankPage']) {
  for (const [label, extra] of variants) {
    const r = await fetch('https://pocketapi.48.cn' + P + ep, {
      method: 'POST',
      headers: { ...base, ...extra },
      body: JSON.stringify({ rankId: 429, nextId: 0 }),
    });
    const t = await r.text();
    const head = t.replace(/\s+/g, ' ').slice(0, 130);
    console.log(`${ep.padEnd(22)} ${label.padEnd(14)} http=${r.status} ${head}`);
    await new Promise(x => setTimeout(x, 400));
  }
}
