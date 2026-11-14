/* 口径验证：「在线人数」到底哪个数才是**当前在看的人**。
 *
 * 已知：getLiveList(debug).onlineUserNum === getLiveOne.onlineNum（实测 410=410）。
 *       但我们全团合计 104,697 / 72 场（均值 1454），别人家的榜最大才 725 —— 差 20 倍。
 * 假设：onlineUserNum 是**累计观看人次**，而房间真实在线 = 云信聊天室在线成员数。
 * 做法：拿 appKey/accid/pwd 连进房间，getChatroomInfo() 读在线成员数，与 onlineNum 对照。
 */
import fs from 'fs';
import { createRequire } from 'node:module';

const SYNC = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const require = createRequire(SYNC);
const { createNimCommonlinkChatroomClient } = require(SYNC + 'nim-client/chatroom.cjs');

const env = fs.readFileSync(SYNC + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const { generatePa } = await import(SYNC + 'nim-client/pa.mjs');
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
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
  return JSON.parse(await r.text());
};

/* ① NIM 凭证 */
const ui = await post('/im/api/v1/im/userinfo', {});
const accid = String((ui.content || {}).accid || '');
const pwd = String((ui.content || {}).pwd || '');
console.log('NIM 凭证 accid=' + accid + ' pwd长度=' + pwd.length);
if (!accid || !pwd) process.exit(1);

/* ② 在播列表（debug 才有 onlineUserNum） */
let list = [];
for (let i = 0; i < 6; i++) {
  const L = await post('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false });
  list = ((L.content || {}).liveList || []).filter((x) => x && x.liveId);
  if (list.length) break;
  const L2 = await post('/live/api/v1/live/getLiveList', { next: '0' });
  list = ((L2.content || {}).liveList || []).filter((x) => x && x.liveId);
  if (list.length) { console.log('（debug 模式返回空，退到普通列表 ' + list.length + ' 场）'); break; }
  await new Promise((z) => setTimeout(z, 2500));
}
console.log('在播', list.length, '场');

/* ③ 抽 6 场：大 / 中 / 小 各取，逐个连房间读在线成员数 */
const sorted = list.map((x) => ({ x, o: Number(x.onlineUserNum) || 0 })).sort((a, b) => b.o - a.o);
const sample = [...sorted.slice(0, 2), ...sorted.slice(Math.floor(sorted.length / 2), Math.floor(sorted.length / 2) + 2), ...sorted.slice(-2)];

for (const { x } of sample) {
  const liveId = String(x.liveId);
  const nm = (x.userInfo || {}).nickname || '';
  const one = (await post('/live/api/v1/live/getLiveOne', { liveId })).content || {};
  const roomId = String(one.roomId || '');
  let nimOnline = '—';
  if (roomId) {
    const c = createNimCommonlinkChatroomClient({ appKey: APPKEY, account: accid, token: pwd, roomId });
    try {
      await c.connect();
      const info = await c.getChatroomInfo();
      const v = typeof info === 'number' ? info : (info && (info.onlineMemberNum ?? info.onlineMemberCount ?? info.online));
      nimOnline = (v === undefined ? JSON.stringify(info).slice(0, 80) : v);
    } catch (e) {
      nimOnline = 'ERR ' + String(e.message || e).slice(0, 60);
    } finally {
      try { c.destroy(); } catch { /* noop */ }
    }
  }
  console.log(`  ${nm.padEnd(18)} 列表onlineUserNum=${x.onlineUserNum}  详情onlineNum=${one.onlineNum}  聊天室在线=${nimOnline}  roomId=${roomId}`);
  await new Promise((z) => setTimeout(z, 800));
}
process.exit(0);
