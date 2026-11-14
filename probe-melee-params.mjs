// 魅力排行（melee rank）参数探测：接口结构已确认，缺的是入参
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
  return [r.status, await r.text()];
};
const U = 159711307;
const cases = [
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, pageNo: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, pageNum: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, nextId: 0, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, meleeId: 0 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { meleeId: 0, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { activityId: 0, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, type: 1, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, rankType: 1, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeRankPage', { starId: U, pageIndex: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getPersonMeleeRankPage', { starId: U, pageNo: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getPersonMeleeRankPage', { userId: U, pageNo: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getPersonMeleeRankPage', { starId: U, meleeId: 0, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getClubMeleeRankPage', { starId: U, pageNo: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getClubMeleeRankPage', { clubId: 1, pageNo: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getClubMeleeRankPage', { teamId: 1, pageNo: 1, pageSize: 20 }],
  ['/gift/api/v1/melee/rank/getMeleeWeekRank', { starId: U, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeWeekRank', { starId: U, week: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeFriends', { starId: U, pageNo: 1 }],
  ['/gift/api/v1/melee/rank/getMeleeFriends', { meleeId: U }],
];
for (const [p, b] of cases) {
  const [c, t] = await post(p, b);
  const brief = t.replace(/\s+/g, ' ').slice(0, 200);
  const empty = /"rankUserList":\[\]/.test(t);
  console.log((empty ? 'EMPTY ' : 'HIT!! ') + c + ' ' + p.replace('/gift/api/v1/melee/rank/', '') + ' ' + JSON.stringify(b));
  if (!empty) console.log('    ', brief);
  await new Promise((r) => setTimeout(r, 130));
}
