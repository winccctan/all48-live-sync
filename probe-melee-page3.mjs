// 最后一轮：组合齐全的分页参数 + clubId 值域
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
const post = async (p, b) => (await (await fetch('https://pocketapi.48.cn' + p, {
  method: 'POST', headers: H, body: JSON.stringify(b || {}),
})).json());
const P = '/gift/api/v1/melee/rank/';
const RID = 429;

const cases = [];
const put = (ep, body) => cases.push([ep, body]);

// 分页组合
for (const ep of ['getMeleeRankPage', 'getMeleeWeekRank', 'getPersonMeleeRankPage', 'getClubMeleeRankPage', 'getMeleeYearRankPage']) {
  put(ep, { rankId: RID, pageNo: 2, pageSize: 50 });
  put(ep, { rankId: RID, pageNo: 1, pageSize: 50 });
  put(ep, { rankId: RID, offset: 7, limit: 50 });
  put(ep, { rankId: RID, nextId: 92037, pageSize: 50 });
  put(ep, { rankId: RID, userId: 614528 });
  put(ep, { rankId: RID, clubId: 1 });
  put(ep, { rankId: RID, teamId: 1 });
}
// clubId 值域
for (const c of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 101]) {
  put('getClubMeleeRankPage', { rankId: RID, clubId: c });
}
// 年榜
for (const y of [0, 1, 2026, 2025]) {
  put('getMeleeYearRank', { rankId: y });
  put('getMeleeYearRankPage', { rankId: y, pageNo: 1, pageSize: 50 });
}
// 看看不带参数
put('getMeleeRankPage', {});
put('getMeleeWeekRank', {});

let best = null;
for (const [ep, body] of cases) {
  let r; try { r = await post(P + ep, body); } catch (e) { console.log('ERR', ep, e.message); continue; }
  const c = r?.content;
  const m = c && (c.meleeRank || c.personMeleeRank || c.clubMeleeRank || c.yearMeleeRank || c);
  const list = m?.rankUserList;
  const n = Array.isArray(list) ? list.length : '?';
  const f = list?.[0];
  const more = typeof n === 'number' && n > 7;
  console.log(`${more ? '★★★' : r.status === 200 && n > 0 ? '★  ' : '   '} ${ep.padEnd(22)} ${JSON.stringify(body).padEnd(50)} st=${r.status} n=${n} first=${f ? f.rankNum + '/' + f.melee + '/' + (f.baseUserInfo?.starName || '') : '-'}`);
  if (more) best = { ep, body, n };
  await new Promise((x) => setTimeout(x, 130));
}
console.log('\n>>> 最大页:', JSON.stringify(best));
