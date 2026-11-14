// 从 6.0.7 dex 挖出的 melee/live rank 全套接口，逐个实测
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
  return { code: r.status, txt: t };
};
const brief = (o, n = 700) => JSON.stringify(o).slice(0, n);

// 先拿基准：getMeleeRankPage（已知能出数据）
const base = await post('/gift/api/v1/melee/rank/getMeleeRankPage', { meleeId: 0 });
let B = null; try { B = JSON.parse(base.txt); } catch {}
console.log('== getMeleeRankPage', base.code, brief(B));
const wk = B?.content?.weekRankList || [];
const yr = B?.content?.yearRank || {};
console.log('   weekRankList:', wk.map((x) => x.weekRankId + ':' + x.weekRankName).join(' | '));
console.log('   yearRank:', brief(yr, 200));

const WID = wk[0]?.weekRankId ?? 0;
const YID = yr?.yearRankId ?? 0;
const tests = [
  ['/gift/api/v1/melee/rank/getMeleeWeekRank', { meleeId: WID }],
  ['/gift/api/v1/melee/rank/getMeleeWeekRank', { weekRankId: WID }],
  ['/gift/api/v1/melee/rank/getMeleeYearRank', { meleeId: YID }],
  ['/gift/api/v1/melee/rank/getMeleeYearRank', { yearRankId: YID }],
  ['/gift/api/v1/melee/rank/getMeleeYearRankPage', { meleeId: YID }],
  ['/gift/api/v1/melee/rank/getMeleeYearRankPage', { yearRankId: YID, nextId: 0 }],
  ['/gift/api/v1/melee/rank/getPersonMeleeRankPage', { meleeId: 0 }],
  ['/gift/api/v1/melee/rank/getPersonMeleeRankPage', { userId: 159711307 }],
  ['/gift/api/v1/melee/rank/getClubMeleeRankPage', { meleeId: 0 }],
  ['/gift/api/v1/melee/rank/getClubMeleeRankPage', { clubId: 0 }],
  ['/gift/api/v1/melee/rank/getMeleeFriends', {}],
  ['/live/api/v1/live/getLiveRank', {}],
  ['/live/api/v1/live/getLiveRank', { rankType: 0 }],
  ['/live/api/v1/live/getOpenLiveMemberRank', {}],
];
for (const [p, b] of tests) {
  const r = await post(p, b);
  let j = null; try { j = JSON.parse(r.txt); } catch {}
  const ok = j && j.status === 200;
  const c = j?.content;
  const shape = c && typeof c === 'object'
    ? Object.keys(c).slice(0, 8).map((k) => k + ':' + (Array.isArray(c[k]) ? `[${c[k].length}]` : typeof c[k])).join(' ')
    : String(c).slice(0, 80);
  console.log(`\n== ${p} ${JSON.stringify(b)}  -> ${r.code} status=${j?.status} ${ok ? 'OK' : 'FAIL'}`);
  console.log('   shape:', shape);
  if (!ok) console.log('   body:', r.txt.slice(0, 200));
  await new Promise((x) => setTimeout(x, 160));
}
