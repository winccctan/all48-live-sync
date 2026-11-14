// rankId 命中后，攻分页：nextId / pageNo 与 rankId 的组合
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
const RID = 429, NID = 92037;

const cases = [];
const put = (ep, body) => cases.push([ep, body]);

// 分页：三个分页接口 × rankId
for (const ep of ['getPersonMeleeRankPage', 'getClubMeleeRankPage', 'getMeleeYearRankPage', 'getMeleeRankPage', 'getMeleeWeekRank', 'getMeleeFriends']) {
  put(ep, { rankId: RID, nextId: NID });
  put(ep, { rankId: RID, nextId: String(NID) });
  put(ep, { rankId: RID, nextPage: NID });
  put(ep, { rankId: RID, pageNo: 2 });
  put(ep, { rankId: RID, page: 2 });
  put(ep, { rankId: RID, offset: 7 });
  put(ep, { rankId: RID, meleeId: NID });
  put(ep, { rankId: RID, lastMelee: 381693 });
  put(ep, { rankId: RID, startMelee: 381693 });
}

for (const [ep, body] of cases) {
  let r; try { r = await post(P + ep, body); } catch (e) { console.log('ERR', ep, e.message); continue; }
  const c = r?.content;
  const m = c && (c.meleeRank || c.personMeleeRank || c.clubMeleeRank || c.yearMeleeRank || c.friendsMeleeRank || c);
  const list = m?.rankUserList;
  const n = Array.isArray(list) ? list.length : '?';
  const f = list?.[0];
  const hit = r.status === 200 && typeof n === 'number' && n > 0 && f?.rankNum !== 1;
  const ok = r.status === 200 && typeof n === 'number' && n > 0;
  console.log(`${hit ? '★★' : ok ? '★ ' : '  '} ${ep.padEnd(22)} ${JSON.stringify(body).padEnd(52)} st=${r.status} n=${n} first=${f ? f.rankNum + '/' + f.melee + '/' + (f.baseUserInfo?.starName || '') : '-'}`);
  await new Promise((x) => setTimeout(x, 140));
}
