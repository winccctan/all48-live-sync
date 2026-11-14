/* 接口活了之后重测游标：之前 nextId「恒 92037、被忽略」是在 500 状态下测的，不可信。 */
import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = { 'Content-Type': 'application/json;charset=utf-8', appInfo: mkApp('7.0.41', '24011601'), token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' };
const post = async (p, body) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  return [r.status, await r.text()];
};
const brief = (t) => {
  try {
    const o = JSON.parse(t); const c = o.content || {};
    const list = c.rankUserList || (c.meleeRank && c.meleeRank.rankUserList) || [];
    const next = c.nextId !== undefined ? c.nextId : (c.meleeRank && c.meleeRank.nextId);
    return { st: o.status, n: list.length, next, first: list[0] && (list[0].baseUserInfo ? list[0].baseUserInfo.starName + ':' + list[0].melee : ''), last: list.length ? (list[list.length - 1].rankNum + ':' + (list[list.length - 1].baseUserInfo || {}).starName + ':' + list[list.length - 1].melee) : '' };
  } catch (e) { return { err: t.slice(0, 60) }; }
};

console.log('=== A. getMeleeWeekRank 游标矩阵 (rankId=429) ===');
for (const body of [
  { rankId: 429 },
  { rankId: 429, nextId: 0 },
  { rankId: 429, nextId: 1 },
  { rankId: 429, nextId: 7 },
  { rankId: 429, nextId: 8 },
  { rankId: 429, nextId: 92037 },
  { rankId: 429, pageSize: 50 },
  { rankId: 429, pageIndex: 1, pageSize: 50 },
  { rankId: 429, nextId: 0, pageSize: 100 },
  { rankId: 429, nextId: '92037' },
]) {
  const [, t] = await post('/gift/api/v1/melee/rank/getMeleeWeekRank', body);
  console.log(' ', JSON.stringify(body).padEnd(46), JSON.stringify(brief(t)));
  await new Promise((x) => setTimeout(x, 350));
}

console.log('\n=== B. getMeleeRankPage 游标 ===');
for (const body of [
  {}, { nextId: 0 }, { nextId: 8 }, { nextId: 92037 }, { pageSize: 50 }, { rankId: 429, nextId: 8 },
  { yearRankId: 0 }, { weekRankId: 429 },
]) {
  const [, t] = await post('/gift/api/v1/melee/rank/getMeleeRankPage', body);
  console.log(' ', JSON.stringify(body).padEnd(46), JSON.stringify(brief(t)));
  await new Promise((x) => setTimeout(x, 350));
}

console.log('\n=== C. 历史周（越早的周是否仍只有 7 人） ===');
for (const rid of [429, 428, 420, 400, 300, 200, 100, 1]) {
  const [, t] = await post('/gift/api/v1/melee/rank/getMeleeWeekRank', { rankId: rid });
  console.log(' rankId=' + String(rid).padEnd(5), JSON.stringify(brief(t)));
  await new Promise((x) => setTimeout(x, 350));
}
