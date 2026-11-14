// getMeleeRankPage 分页实测：确认是「成员鸡腿榜」并尝试翻全
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

const j = await post('/gift/api/v1/melee/rank/getMeleeRankPage', { meleeId: 0 });
const mr = j?.content?.meleeRank || {};
console.log('nextId =', mr.nextId, '| rankUserList 长度 =', (mr.rankUserList || []).length);
console.log('第一行完整结构:');
console.log(JSON.stringify(mr.rankUserList?.[0], null, 1).slice(0, 1400));
console.log('\n全部 7 行：rankNum / melee / 名字 / userId');
for (const x of mr.rankUserList || []) {
  const u = x.baseUserInfo || {};
  console.log('  ', x.rankNum, String(x.melee).padStart(8), (u.nickname || u.realNickName || '?'), u.userId, '| showMeleeNum=', x.showMeleeNum, '| topUserInfo=', x.topUserInfo ? 'yes' : 'no');
}

// 翻页实验
const NID = mr.nextId;
const tries = [
  { meleeId: 0, nextId: NID },
  { meleeId: 0, nextId: String(NID) },
  { meleeId: 0, lastId: NID },
  { meleeId: 0, startId: NID },
  { meleeId: 0, pageNo: 2 },
  { meleeId: 0, page: 2 },
  { meleeId: 0, offset: 7 },
  { meleeId: 0, currentPage: 2 },
  { meleeId: 0, nextId: NID, pageSize: 50 },
];
for (const b of tries) {
  const r = await post('/gift/api/v1/melee/rank/getMeleeRankPage', b);
  const m = r?.content?.meleeRank || {};
  const first = m.rankUserList?.[0];
  console.log(`\n${JSON.stringify(b).padEnd(42)} -> status=${r.status} n=${(m.rankUserList || []).length} firstRank=${first?.rankNum} firstMelee=${first?.melee} nextId=${m.nextId}`);
  await new Promise((x) => setTimeout(x, 200));
}
