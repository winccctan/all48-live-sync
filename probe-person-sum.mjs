/* 外层无成员总分 ⇒ 试「TOP16 金主 totalCharm 求和 ≈ 官方 melee?」
 * 若相等：官方给的金主榜是完整闭集，可用它反推成员总分（并校验我们自己的流水）。
 * 若远小于：只是截断的 TOP16，反推无效。 */
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
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return { status: r.status, raw: t.slice(0, 100) }; }
};

/* 官方 TOP7（rankId 429）作为对照 */
const week = await post('/gift/api/v1/melee/rank/getMeleeWeekRank', { rankId: 429 });
const top = (week.content && week.content.rankUserList || []).map((x) => ({
  uid: x.baseUserInfo.userId, name: x.baseUserInfo.starName || x.baseUserInfo.nickname, melee: x.melee,
}));
console.log('官方 TOP7：', top.map((x) => x.name + ':' + x.melee).join(' | '));

for (const m of top.slice(0, 4)) {
  const o = await post('/gift/api/v1/melee/rank/getPersonMeleeRankPage', { resId: m.uid });
  const c = o.content || {};
  const arr = c.charmInfo || [];
  const sum = arr.reduce((a, x) => a + (Number(x.totalCharm) || 0), 0);
  console.log(`\n${m.name}  官方=${m.melee}  TOP${arr.length} 金主 totalCharm 和=${sum}  覆盖=${(sum / m.melee * 100).toFixed(1)}%`);
  console.log('  外层键:', Object.keys(c).join(','));
  arr.slice(0, 4).forEach((x) => {
    const u = x.userInfo || {};
    console.log(`   #${x.rankNum} ${u.nickname} ${x.totalCharm} privacy=${x.privacy}`);
  });
  if (arr.length) console.log('  金主条目全部字段:', Object.keys(arr[0]).join(','));
  await new Promise((x) => setTimeout(x, 500));
}
