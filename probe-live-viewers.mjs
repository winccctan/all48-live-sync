/* 探「在直播间的人（含只围观不说话的）」：
 * 6.0.7 dex 里翻出两个从未试过的名字 —— getLiveJoiners / getLiveOnline，
 * 还有 getLiveBraageList（弹幕）、getLiveTeamMemberList。逐个打，看哪个活着、返什么。 */
import fs from 'fs';

const SYNC = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(SYNC + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const { generatePa } = await import(SYNC + 'nim-client/pa.mjs');

const mkApp = (v, b) => JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios',
  deviceName: 'iPhone XR', os: 'ios',
});
const H = {
  'Content-Type': 'application/json;charset=utf-8',
  appInfo: mkApp('7.0.41', '24011601'),
  token: pick('POCKET48_TOKEN'),
  pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1',
  'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
};

async function post(path, body) {
  const r = await fetch('https://pocketapi.48.cn' + path, { method: 'POST', headers: H, body: JSON.stringify(body || {}) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* 非 JSON */ }
  return { code: r.status, j, t };
}

/* 取一场正在播的 */
const L = await post('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false });
const list = ((L.j && L.j.content && L.j.content.liveList) || []).filter((x) => x && x.liveId);
const live = list.find((x) => Number(x.onlineUserNum) > 0) || list[0] || {};
const liveId = String(live.liveId || '');
const nick = (live.userInfo && (live.userInfo.nickname || live.userInfo.starName)) || '';
console.log('样本场次', liveId, nick, '在线', live.onlineUserNum);
if (!liveId) process.exit(1);

const BODIES = [
  {},
  { liveId },
  { liveId, page: 1 },
  { liveId, page: 1, limit: 50 },
  { liveId, next: 0 },
  { liveId, type: 0 },
  { liveId, type: 1 },
];

const EPS = ['getLiveOnline', 'getLiveJoiners', 'getLiveBraageList', 'getLiveTeamMemberList', 'getOpenLiveMemberRank'];

for (const ep of EPS) {
  console.log('\n=== ' + ep + ' ===');
  for (const body of BODIES) {
    const { code, j, t } = await post('/live/api/v1/live/' + ep, body);
    const st = j ? j.status : '?';
    const content = j && j.content;
    let shape = '';
    if (content === undefined) shape = '(无 content)';
    else if (Array.isArray(content)) shape = 'array(' + content.length + ')';
    else if (content && typeof content === 'object') {
      const ks = Object.keys(content);
      shape = 'obj[' + ks.slice(0, 6).join(',') + ']' + (content.total !== undefined ? ' total=' + content.total : '');
    } else shape = typeof content;
    console.log('  body=' + JSON.stringify(body).slice(0, 46) + ' → http ' + code + ' status=' + st + ' ' + shape);
    if (j && j.status === 200 && content !== undefined) {
      const s = Array.isArray(content) ? JSON.stringify(content.slice(0, 1)) : JSON.stringify(content);
      console.log('      ', s.slice(0, 420));
    } else if (!j && code !== 200) {
      console.log('      raw:', String(t).slice(0, 160));
    }
  }
}
