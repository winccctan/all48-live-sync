/**
 * 用 node-nim（网易云信 C++ SDK 的 Node 绑定）进直播间收消息
 *
 * 照着 qqtools 的打包流程（packages/main/src/ipcHandle/nodeNimHandleLogin.mts）：
 *   ① nim.client.init(appKey, appDataDir, '', {})
 *   ② nim.client.login(appKey, account, token, null, '')      ← 先登录 IM
 *   ③ nim.plugin.chatRoomRequestEnterAsync(roomId, null, '')  ← 拿入房票据
 *   ④ chatroom.enter(roomId, 票据, {}, '')                    ← 再进聊天室
 *
 * 用法：NICK=康楚翊 SEC=60 node probe-nodenim.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { postJson } from './lib/api.mjs';

const require = createRequire(import.meta.url);
const NODE_NIM_PATH = process.env.NODE_NIM_PATH || '/Users/tansy/.workbuddy/binaries/node-nim/node-nim';
const nodeNim = require(NODE_NIM_PATH);

const TOKEN = process.env.POCKET48_TOKEN || '';
const APPKEY = '632feff1f4c838541ab75195d1ceb3fa';
const WANT = process.env.NICK || '康楚翊';
const SEC = Math.max(20, Number(process.env.SEC || 60));
const APP_DATA = process.env.NIM_APP_DATA || path.resolve('nim-state/node-nim-data');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const bj = (s) => new Date(s * 1000 + 8 * 3600e3).toISOString().slice(5, 19);

// ① 目标场次
const lr = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
const list = (lr.content && lr.content.liveList) || [];
const s = list.find((x) => String((x.userInfo && x.userInfo.nickname) || '').includes(WANT)) || list[0];
if (!s) { console.error('没有在播场次'); process.exit(1); }
const nick = String((s.userInfo && s.userInfo.nickname) || s.liveId);
const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 2 })).content || {};
const roomId = Number(one.roomId);
log(`目标 ${nick} liveId=${s.liveId} roomId=${roomId}`);

// ② 凭证
const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN, retries: 2 });
const c = (info && info.content) || {};
// 🔴 关键：account / token 到底用哪一套？三种组合各试一次
const MODE = process.env.ACCT_MODE || 'accid_pwd';
const ACCID = String(c.accid || '');
const USERID = String(c.userId || '');
const PWD = String(c.pwd || '');
const PA = String(TOKEN);
const combos = {
  accid_pwd: [ACCID, PWD],          // 云信 accid + im/userinfo 的 pwd（当前失败的那套）
  accid_pa: [ACCID, PA],            // 云信 accid + 口袋48 token
  userid_pwd: [USERID, PWD],        // userId + pwd
  userid_pa: [USERID, PA],          // userId + 口袋48 token
};
const [account, pwd] = combos[MODE] || combos.accid_pwd;
log(`模式=${MODE} account=${account.slice(0, 28)}${account.length > 28 ? '…' : ''} token长度=${pwd.length}`);

// ③ client init
fs.mkdirSync(APP_DATA, { recursive: true });
const ok = nodeNim.nim.client.init(APPKEY, APP_DATA, '', {});
log('client.init =', ok);
if (!ok) { console.error('初始化失败'); process.exit(1); }
nodeNim.nim.initEventHandlers();

// ④ 登录
const loginRes = await nodeNim.nim.client.login(APPKEY, account, pwd, null, '');
const r = loginRes && loginRes[0];
log('login 结果：', JSON.stringify(r));
if (!r || r.res_code_ !== nodeNim.NIMResCode.kNIMResSuccess) {
  log('🔴 登录失败 res_code_ =', r && r.res_code_, '（成功应为', nodeNim.NIMResCode.kNIMResSuccess, '）');
  process.exit(2);
}
log('✅ IM 登录成功');

// ⑤ 申请进聊天室
const [enterCode, enterResult] = await nodeNim.nim.plugin.chatRoomRequestEnterAsync(roomId, null, '');
log('chatRoomRequestEnterAsync code =', enterCode, '票据长度 =', String(enterResult || '').length);
if (enterCode !== nodeNim.NIMResCode.kNIMResSuccess) { console.error('申请进房失败'); process.exit(3); }

// ⑥ chatroom 实例
const chatroom = new nodeNim.ChatRoom();
chatroom.init('', '');
chatroom.initEventHandlers();

let msgs = 0, gifts = 0, entered = false;
chatroom.on('enter', (rid, step, code2, roomInfo, myInfo) => {
  log(`enter 回调：step=${step} code=${code2} room=${JSON.stringify(roomInfo && roomInfo.name || '').slice(0, 40)} 我=${JSON.stringify(myInfo && myInfo.nick || '').slice(0, 30)}`);
  if (step === 5 && code2 === 200) { entered = true; log('✅ 进入聊天室成功'); }
});
chatroom.on('receiveMsg', (n, msg) => {
  msgs++;
  const txt = String((msg && (msg.content || msg.msgContent || '')) || '');
  if (/弦月|礼物|送给/.test(txt)) {
    gifts++;
    if (gifts <= 8) log(`🎁 [#${msg.time ? bj(msg.time) : '?'}] ${String(msg.fromNick || msg.from || '').slice(0, 16)}: ${txt.slice(0, 160)}`);
  }
  if (msgs <= 3) log(`📨 消息样本: ${txt.slice(0, 180)}`);
});
chatroom.on('exit', (rid, code2, reason) => log(`⚠️ exit code=${code2} reason=${reason}`));
chatroom.on('linkCondition', (c) => log('🔗 linkCondition =', c));

chatroom.enter(roomId, enterResult, {}, '');
log('已发起 enter，观察', SEC, '秒…');

setTimeout(() => {
  log(`\n结果：entered=${entered} msgs=${msgs} 礼物相关=${gifts}`);
  try { chatroom.exit(); } catch {}
  try { nodeNim.nim.client.logout(); } catch {}
  process.exit(0);
}, SEC * 1000);
