/* 用云信 web SDK 进房间，读「聊天室在线成员数」并试拉成员列表。
 * 判据：如果聊天室在线数 ≈ 别人家榜上的数（几十~几百），而 onlineNum 是 8000+，
 * 就说明 onlineNum 是累计热度，真在线要靠聊天室。 */
import fs from 'fs';
import { createRequire } from 'node:module';
/* Node 22 的 globalThis.navigator 是只读 getter，SDK 一赋值就崩 ⇒ 先把它变成可写 */
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, writable: true, configurable: true }); } catch { /* 已是可写 */ }

const SYNC = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const require = createRequire(SYNC);
const SDK = require(SYNC + 'node_modules/@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');

const env = fs.readFileSync(SYNC + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const { generatePa } = await import(SYNC + 'nim-client/pa.mjs');
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const mkApp = (v, b) => JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});
const H = {
  'Content-Type': 'application/json;charset=utf-8', appInfo: mkApp('7.0.41', '24011601'),
  token: pick('POCKET48_TOKEN'), pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
};
const post = async (p, b) => JSON.parse(await (await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) })).text());

const ui = await post('/im/api/v1/im/userinfo', {});
const accid = String((ui.content || {}).accid || '');
const pwd = String((ui.content || {}).pwd || '');
console.log('accid', accid);

let list = [];
for (let i = 0; i < 5; i++) {
  const j = await post('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false });
  list = ((j.content || {}).liveList || []).filter((x) => x && x.liveId);
  if (list.length) break;
  await new Promise((z) => setTimeout(z, 2000));
}
const srt = list.map((x) => ({ x, o: Number(x.onlineUserNum) || 0 })).sort((a, b) => b.o - a.o);
const targets = [srt[0], srt[Math.floor(srt.length / 2)], srt[srt.length - 1]].filter(Boolean);
console.log('在播', list.length, '场，测', targets.length, '场');

for (const { x } of targets) {
  const liveId = String(x.liveId);
  const nm = (x.userInfo || {}).nickname || '';
  const one = (await post('/live/api/v1/live/getLiveOne', { liveId })).content || {};
  const roomId = String(one.roomId || '');
  if (!roomId) { console.log(`  ${nm}: 没有 roomId，跳过`); continue; }
  await new Promise((resolve) => {
    let done = false;
    const finish = (msg) => { if (done) return; done = true; console.log(msg); try { cr.destroy(); } catch { } resolve(); };
    const timer = setTimeout(() => finish(`  ${nm}: 超时（20s 没进房）`), 20000);
    const cr = SDK.Chatroom.getInstance({
      appKey: APPKEY, account: accid, token: pwd, chatroomId: roomId, db: false,
      chatroomAddresses: ['weblink01.netease.im:443', 'chatweblink01.netease.im:443'],
      onconnect(info) {
        clearTimeout(timer);
        const room = (info && (info.chatroom || info)) || {};
        const online = room.onlineMemberNum ?? info?.onlineMemberNum;
        console.log(`  ${nm}: 接口 onlineNum=${one.onlineNum} | 聊天室 onlineMemberNum=${online} | roomId=${roomId}`);
        console.log('     onconnect 顶层键:', Object.keys(info || {}).join(','));
        if (typeof cr.getChatroomMembers === 'function') {
          cr.getChatroomMembers({
            guest: false, limit: 20,
            done: (err, obj) => {
              clearTimeout(timer);
              if (err) return finish(`     成员列表失败 ${err.code || ''} ${err.message || ''}`.trim());
              const ms = (obj && (obj.members || obj)) || [];
              const arr = Array.isArray(ms) ? ms : (ms.members || []);
              finish(`     成员 ${arr.length} 人，样本: ` + JSON.stringify(arr.slice(0, 3)).slice(0, 300));
            },
          });
        } else finish('     SDK 没有 getChatroomMembers');
      },
      onerror(e) { clearTimeout(timer); finish(`  ${nm}: 错误 ${JSON.stringify(e).slice(0, 120)}`); },
    });
  });
  await new Promise((z) => setTimeout(z, 600));
}
process.exit(0);
