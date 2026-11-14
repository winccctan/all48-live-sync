/* getLiveJoiners / getLiveOnline 是 Model 的 getter（404 说明没有这两个接口），
 * 那 joiners 很可能就在 getLiveOne 的返回里。这里把 getLiveOne 全字段摊开看。 */
import fs from 'fs';

const SYNC = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(SYNC + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const { generatePa } = await import(SYNC + 'nim-client/pa.mjs');
const mkApp = (v, b) => JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});
const H = {
  'Content-Type': 'application/json;charset=utf-8',
  appInfo: mkApp('7.0.41', '24011601'),
  token: pick('POCKET48_TOKEN'),
  pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1',
  'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
};
const post = async (p, b) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { code: r.status, j, t };
};

const L = await post('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false });
const list = ((L.j && L.j.content && L.j.content.liveList) || []).filter((x) => x && x.liveId);
const live = list.find((x) => Number(x.onlineUserNum) > 0) || list[0] || {};
const liveId = String(live.liveId || '');
console.log('场次', liveId, (live.userInfo || {}).nickname, '在线', live.onlineUserNum);

const O = await post('/live/api/v1/live/getLiveOne', { liveId });
const c = (O.j && O.j.content) || {};
console.log('\ngetLiveOne 顶层键:', Object.keys(c).join(','));
for (const [k, v] of Object.entries(c)) {
  if (Array.isArray(v)) console.log(`  ${k}: array(${v.length})`, JSON.stringify(v.slice(0, 2)).slice(0, 300));
  else if (v && typeof v === 'object') console.log(`  ${k}: obj[${Object.keys(v).slice(0, 8).join(',')}]`);
  else console.log(`  ${k}: ${JSON.stringify(v)}`);
}

/* 再试几个可能在别的前缀下的观众接口 */
const TRY = [
  ['/live/api/v1/live/getLiveOnlineUser', { liveId }],
  ['/live/api/v1/live/getOnlineUserList', { liveId }],
  ['/live/api/v1/live/getLiveAudience', { liveId }],
  ['/live/api/v1/live/getLiveViewerList', { liveId }],
  ['/live/api/v1/live/getLiveMemberList', { liveId }],
  ['/live/api/v1/live/getLiveUserList', { liveId }],
  ['/live/api/v1/live/getJoinUserList', { liveId }],
  ['/live/api/v1/room/getLiveJoiners', { liveId }],
  ['/live/api/v1/room/getOnlineList', { liveId }],
];
console.log('\n=== 其他候选 ===');
for (const [p, b] of TRY) {
  const { code, j } = await post(p, b);
  const st = j ? j.status : '?';
  const ct = j && j.content;
  const shape = ct === undefined ? '-' : (Array.isArray(ct) ? 'array(' + ct.length + ')' : (ct && typeof ct === 'object' ? 'obj[' + Object.keys(ct).slice(0, 5).join(',') + ']' : typeof ct));
  console.log(`  ${p.replace('/live/api/v1/', '')} → http ${code} status ${st} ${shape}`);
}
