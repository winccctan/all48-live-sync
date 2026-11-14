// 魅力排行（melee rank）完整结构 + 周榜/年榜
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
const dump = (o, pre = '') => {
  for (const k of Object.keys(o || {})) {
    const v = o[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) dump(v, pre + k + '.');
    else if (Array.isArray(v)) console.log(pre + k, '= [数组]', v.length, v.length ? JSON.stringify(v[0]).slice(0, 200) : '');
    else console.log(pre + k, '=', String(v).slice(0, 60));
  }
};

const main = await post('/gift/api/v1/melee/rank/getMeleeRankPage', { meleeId: 0 });
fs.writeFileSync('/tmp/melee-main.json', JSON.stringify(main, null, 1));
console.log('=== getMeleeRankPage 结构 ===');
dump(main.content || {});

const wk = main.content?.weekRankList || [];
const yr = main.content?.yearRank || {};
console.log('\n=== 周榜列表 ===', wk.slice(0, 6).map((x) => x.weekRankId + ':' + x.weekRankName).join(' | '));

// 周榜本体
for (const w of wk.slice(0, 2)) {
  const r = await post('/gift/api/v1/melee/rank/getMeleeWeekRank', { meleeId: w.weekRankId });
  console.log('\n=== getMeleeWeekRank', w.weekRankId, w.weekRankName, '===');
  console.log(JSON.stringify(r).slice(0, 900));
  await new Promise((x) => setTimeout(x, 150));
}
// 年榜本体
const r2 = await post('/gift/api/v1/melee/rank/getMeleeYearRank', { meleeId: yr.yearRankId ?? 0 });
console.log('\n=== getMeleeYearRank ===');
console.log(JSON.stringify(r2).slice(0, 900));
