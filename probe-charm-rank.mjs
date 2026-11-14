// 探测「魅力排行」接口（7.x 新增，6.0.7 dex 里没有，只能按类名/命名习惯试）
import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
  osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});
const H = {
  'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1',
  'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
};
const post = async (p, b) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) });
  const t = await r.text();
  return [r.status, t];
};

const U = 159711307; // 曹可甜
const paths = [
  '/gift/api/v1/charm/rank',
  '/gift/api/v1/charm/rank/list',
  '/gift/api/v1/charm/rank/detail',
  '/gift/api/v1/charm/rank/item',
  '/gift/api/v1/rank/charm',
  '/gift/api/v1/rank/list',
  '/gift/api/v1/rank/main',
  '/gift/api/v1/rank',
  '/gift/api/v1/devote/rank',
  '/gift/api/v1/devote/rank/list',
  '/gift/api/v1/melee/rank/getMeleeRankPage',
  '/gift/api/v1/melee/rank/getMeleeWeekRank',
  '/gift/api/v1/melee/rank/getMeleeYearRank',
  '/gift/api/v1/melee/rank/getMeleeFriends',
  '/gift/api/v1/melee/rank/getClubMeleeRankPage',
  '/gift/api/v1/melee/rank/getPersonMeleeRankPage',
  '/gift/api/v1/gift/rank',
  '/gift/api/v1/gift/list',
  '/gift/api/v1/gift/info',
];
const bodies = [
  { userId: U },
  { starId: U },
  { pageNo: 1, pagesize: 20 },
  {},
];
for (const p of paths) {
  for (const b of bodies) {
    const [c, t] = await post(p, b);
    if (c !== 404) {
      console.log('==', c, p, JSON.stringify(b), '\n   ', t.slice(0, 260));
    }
    await new Promise((r) => setTimeout(r, 110));
  }
}
console.log('done');
