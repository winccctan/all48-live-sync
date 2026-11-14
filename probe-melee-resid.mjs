/* 参数名修正后重测 melee 全族：上一轮全部用 rankId/nextId，
 * 而 getPersonMeleeRankPage 实际只认 resId ⇒ 之前的 500 可能全是参数名错。
 * 这里对每个接口 × 参数组合跑一遍，200 且带数据的才算活。 */
import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');

const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = (v, b) => ({
  'Content-Type': 'application/json;charset=utf-8',
  appInfo: mkApp(v, b), token: TOKEN, pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1',
  'User-Agent': `PocketFans201807/${v} (iPhone; iOS 16.3.1; Scale/2.00)`,
});
const post = async (p, body) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H('7.0.41', '24011601'), body: JSON.stringify(body || {}) });
  return [r.status, await r.text()];
};

const WYC = 89653517;
const EPs = [
  'getMeleeRankPage', 'getMeleeWeekRank', 'getPersonMeleeRankPage', 'getClubMeleeRankPage',
  'getMeleeYearRank', 'getMeleeClubRank', 'getMeleeFriendsRank', 'getMeleeRank',
  'getMeleeCharmRank', 'getMeleeContributionRank', 'getPersonMeleeWeekRank', 'getMeleeMemberRank',
];
const BODIES = [
  ['resId', { resId: WYC }],
  ['empty', {}],
  ['rankId429', { rankId: 429 }],
  ['resId+nextId', { resId: WYC, nextId: 0 }],
  ['resId+rankId', { resId: WYC, rankId: 429 }],
];

for (const ep of EPs) {
  const row = [];
  for (const [tag, b] of BODIES) {
    const [s, t] = await post('/gift/api/v1/melee/rank/' + ep, b);
    let ok = -1, len = 0, note = '';
    try { const o = JSON.parse(t); ok = o.status; const c = o.content; len = c ? JSON.stringify(c).length : 0;
      if (c && typeof c === 'object') note = Object.keys(c).slice(0, 6).join(','); } catch (e) { note = 'non-json'; }
    row.push(`${tag}:${s}/${ok}/${len}${note ? '[' + note + ']' : ''}`);
    await new Promise((x) => setTimeout(x, 300));
  }
  console.log(ep.padEnd(28), row.join('  '));
}
