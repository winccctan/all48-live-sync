// 暴力试参数：把 weekRankId / yearRankId 灌进每个同族接口
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
const P = '/gift/api/v1/melee/rank/';
const WID = 429, YID = 0;

const cases = [];
const put = (ep, body) => cases.push([ep, body]);

// getMeleeRankPage 灌周榜 id
for (const k of ['meleeId', 'weekRankId', 'rankId', 'id']) put('getMeleeRankPage', { [k]: WID });
for (const k of ['meleeId', 'weekRankId', 'rankId', 'id']) put('getMeleeWeekRank', { [k]: WID });
put('getMeleeWeekRank', { meleeId: WID, type: 1 });
put('getMeleeWeekRank', { meleeId: WID, rankType: 1 });
put('getMeleeWeekRank', { weekRankId: WID, nextId: 0 });
put('getMeleeWeekRank', { weekRankId: WID, pageNo: 1 });
put('getMeleeWeekRank', { meleeId: 1, weekRankId: WID });
put('getMeleeWeekRank', { meleeId: 0, weekRankId: WID });
put('getMeleeWeekRank', { meleeId: WID, weekRankId: WID });
put('getMeleeWeekRank', { meleeId: WID, meleeType: 1 });
for (const k of ['meleeId', 'yearRankId', 'rankId']) put('getMeleeYearRank', { [k]: YID });
put('getMeleeYearRank', { yearRankId: YID, nextId: 0 });
put('getMeleeYearRank', { meleeId: YID, yearRankId: YID });
// 分页类
put('getPersonMeleeRankPage', { meleeId: 0, nextId: 92037 });
put('getPersonMeleeRankPage', { meleeId: 0, nextId: 0 });
put('getPersonMeleeRankPage', { userId: 614528, meleeId: 0 });
put('getPersonMeleeRankPage', { meleeId: 429, nextId: 92037 });
put('getClubMeleeRankPage', { clubId: 0, meleeId: 0 });
put('getClubMeleeRankPage', { meleeId: 0, nextId: 92037 });
put('getClubMeleeRankPage', { teamId: 0, meleeId: 0 });
put('getMeleeYearRankPage', { yearRankId: YID, nextId: 92037 });
put('getMeleeYearRankPage', { yearRankId: YID, nextId: 0, meleeId: 0 });
put('getMeleeFriends', { meleeId: 0 });
put('getMeleeFriends', { nextId: 0 });

for (const [ep, body] of cases) {
  const r = await post(P + ep, body);
  const c = r?.content;
  const m = c?.meleeRank || c?.personMeleeRank || c?.clubMeleeRank || c?.yearMeleeRank || c;
  const n = Array.isArray(m?.rankUserList) ? m.rankUserList.length : (Array.isArray(m) ? m.length : '?');
  const f = m?.rankUserList?.[0];
  const ok = r.status === 200 && n !== '?' && n > 0;
  console.log(`${ok ? '★' : ' '} ${ep.padEnd(22)} ${JSON.stringify(body).padEnd(46)} status=${r.status} n=${n} first=${f ? f.rankNum + '/' + f.melee + '/' + (f.baseUserInfo?.starName || f.baseUserInfo?.nickname) : '-'} nextId=${m?.nextId}`);
  await new Promise((x) => setTimeout(x, 150));
}
