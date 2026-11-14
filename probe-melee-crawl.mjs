// 魅力排行全量抓取：总榜翻页 + 周榜/年榜参数定位
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
  return await r.json();
};

// 1. 总榜翻页
let nextId = 0, all = [], pages = 0;
while (pages < 30) {
  const j = await post('/gift/api/v1/melee/rank/getMeleeRankPage', { meleeId: 0, nextId });
  const c = j.content || {};
  const mr = c.meleeRank || {};
  const list = mr.rankUserList || [];
  for (const x of list) {
    all.push({
      rank: x.rankNum,
      uid: x.baseUserInfo?.userId,
      name: x.baseUserInfo?.nickname || x.baseUserInfo?.starName,
      melee: x.melee,
      diff: x.differenceMelee,
    });
  }
  pages++;
  if (!list.length) break;
  const n = Number(mr.nextId || 0);
  if (!n || n === nextId) break;
  nextId = n;
  await new Promise((r) => setTimeout(r, 130));
}
console.log('总榜条数', all.length, '页数', pages);
console.log(all.slice(0, 8).map((x) => `${x.rank}. ${x.name} ${x.melee}`).join('\n'));
console.log('...\n', all.slice(-4).map((x) => `${x.rank}. ${x.name} ${x.melee}`).join('\n'));
fs.writeFileSync('/tmp/melee-all.json', JSON.stringify(all, null, 1));

// 2. 周榜/年榜参数定位
const U = 159711307;
const tries = [
  ['getMeleeWeekRank', { weekRankId: 429 }],
  ['getMeleeWeekRank', { meleeId: 429, nextId: 0 }],
  ['getMeleeWeekRank', { meleeId: 429, weekRankId: 429 }],
  ['getMeleeWeekRank', { weekRankId: 429, nextId: 0 }],
  ['getMeleeYearRank', { yearRankId: 0 }],
  ['getMeleeYearRank', { meleeId: 0, yearRankId: 0 }],
  ['getMeleeYearRankPage', { meleeId: 0 }],
];
for (const [p, b] of tries) {
  const j = await post('/gift/api/v1/melee/rank/' + p, b);
  const c = j.content || {};
  const n = (c.rankUserList || []).length;
  console.log(n ? 'HIT ' : 'empty', p, JSON.stringify(b), '->', n, '条 |', JSON.stringify(c).slice(0, 180));
  await new Promise((r) => setTimeout(r, 140));
}
