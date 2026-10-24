/*
 * 探针 v4：直播间实时消息（网易云信 NIM Chatroom 长连接）。
 *
 * 为什么改这条：v1–v3 用的是「直播结束后才落地」的弹幕 LRC（getLiveOne.msgFilePath），
 * 在播场次根本没有这个字段。但口袋 App 的直播间弹幕是实时的 —— 走的是 NIM 长连接。
 * 王语晨补档站的 research/nim_online_probe.mjs 已经验证过这条路能进聊天室。
 *
 * 链路：
 *   ① POST /im/api/v1/im/userinfo      → 拿自己的 NIM 凭证 {accid, pwd}
 *   ② POST /live/api/v1/live/getLiveList {record:false} → 在播场次
 *   ③ POST /live/api/v1/live/getLiveOne {liveId}        → content.roomId（= NIM chatroomId）
 *   ④ NIM Chatroom 连进去，监听 message → 打印类型与内容
 *
 * 本探针只回答一个问题：**直播间到底有没有「弦月回响」的礼物消息，长什么样**。
 * 不写站点、不上报。
 */
import { createRequire } from 'node:module';
import { postJson } from './lib/api.mjs';

const require = createRequire(import.meta.url);

// Node 的 navigator 是只读 getter，NIM SDK 会写它
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Node)', platform: 'node', language: 'zh-CN', languages: ['zh-CN'], onLine: true, appName: 'node' },
    writable: true, configurable: true,
  });
} catch { /* noop */ }
try {
  const xhr2 = require('xhr2');
  if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2;
} catch { /* noop */ }
// 🔴 Chatroom SDK 会摸 window，Node 里必须补
try { if (!globalThis.window) globalThis.window = globalThis; } catch { /* noop */ }

const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const TOKEN = process.env.POCKET48_TOKEN || '';
const LISTEN = Math.max(15, Number(process.env.NIM_LISTEN || 90));   // 听多少秒
const log = (...a) => console.log(...a);

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

/* ① NIM 凭证 */
let accid = '', pwd = '';
try {
  const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN });
  accid = (info && info.content && info.content.accid) || '';
  pwd = (info && info.content && info.content.pwd) || '';
} catch (e) {
  console.error('取 NIM 凭证失败：' + String(e.message).slice(0, 140));
  process.exit(1);
}
if (!accid || !pwd) { console.error('im/userinfo 没返回 accid/pwd'); process.exit(1); }
log(`NIM 凭证 accid=${accid}`);

/* ② 在播场次（record:false） */
const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
const list = (r && r.content && r.content.liveList) || [];
log(`在播/近期场次 ${list.length} 场`);
if (!list.length) { console.error('现在没有直播，换个时间再跑'); process.exit(0); }

/* ③ 拿 roomId（= chatroomId） */
const rooms = [];
for (const x of list) {
  const liveId = String(x.liveId);
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId }, { token: TOKEN, retries: 1 });
    const c = (d && d.content) || {};
    if (c.roomId) {
      rooms.push({
        liveId,
        roomId: Number(c.roomId),
        nick: (x.userInfo && x.userInfo.nickname) || (c.user && c.user.nickname) || '?',
        online: Number(c.onlineNum) || 0,
      });
    } else {
      log(`  ${nick(x)} 没有 roomId`);
    }
  } catch (e) {
    log(`  ${nick(x)} getLiveOne 失败 ${String(e.message).slice(0, 60)}`);
  }
}
function nick(x) { return (x.userInfo && x.userInfo.nickname) || String(x.liveId); }
log(`有 roomId 的场次 ${rooms.length} 场：` + JSON.stringify(rooms.slice(0, 6)));

if (!rooms.length) { console.error('没有可进的直播间'); process.exit(0); }

/* ④ 进聊天室监听 */
let NIMSDK;
try {
  // 🔴 必须是 **Chatroom 专用** SDK：完整版 NIM_Web_SDK 需要先 login 才能进聊天室，
  //    直接 getInstance 不会建连（实测 90s 收 0 条、连 onconnect 都不触发）。
  NIMSDK = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_Chatroom_nodejs.js');
} catch (e) {
  console.error('加载 NIM Chatroom SDK 失败：' + String(e.message).slice(0, 200));
  process.exit(1);
}

// 先只进第一个房间（人最多的那间），避免多连接互相干扰
rooms.sort((a, b) => b.online - a.online);
const room = rooms[0];
log(`\n进入直播间：${room.nick}  chatroomId=${room.roomId}  在线 ${room.online}`);

const seenTypes = {};
const giftMsgs = [];
const rawSamples = [];
let total = 0;

const chatroom = NIMSDK.getInstance({
  appKey: APPKEY,
  account: accid,
  token: pwd,
  chatroomId: room.roomId,
  // 🔴 不硬编码 chatroomAddresses：写死 chatweblink01 时登录会报 13_2（非法操作或没有权限）。
  //    交给 SDK 走 lbs.netease.im 自己解析当前可用节点。
  db: false,
  onconnect() { log('✅ NIM 已连上聊天室'); },
  onerror(e) { log('⚠️ NIM 错误：' + ((e && (e.message || e.code)) || e)); },
  onwillreconnect() { log('↻ 重连中…'); },
  ondisconnect(e) { log('⚠️ 断开：' + ((e && (e.message || e.code)) || e)); },
});

/** 消息处理：把类型、文本、自定义体都摊开看 */
function onMsg(m) {
  if (!m) return;
  total++;
  const type = String(m.type || 'unknown');
  seenTypes[type] = (seenTypes[type] || 0) + 1;
  const from = (m.fromNick || m.from) || '?';
  let txt = '';
  if (typeof m.text === 'string') txt = m.text;
  else if (typeof m.content === 'string') txt = m.content;
  else if (m.content) txt = JSON.stringify(m.content);
  if (rawSamples.length < 12) {
    rawSamples.push({ type, from, txt: String(txt).slice(0, 220) });
  }
  // 礼物关键字：口袋自定义消息里通常带 gift / 礼物 / 送给
  if (/gift|礼物|送给|弦月/i.test(txt) || /gift/i.test(type)) {
    giftMsgs.push({ type, from, txt: String(txt).slice(0, 400) });
  }
  if (giftMsgs.length && giftMsgs.length <= 30) {
    log(`  🎁 [${type}] ${from}: ${String(txt).slice(0, 200)}`);
  }
}

// 事件名兼容：chatroom 的消息事件在不同 SDK 版本里可能是 'message' 或 'ChatroomMessage'
for (const ev of ['message', 'ChatroomMessage', 'chatroomMessage']) {
  chatroom.on?.(ev, (m) => { if (ev === 'message') onMsg(m); });
}

setTimeout(() => {
  log(`\n===== 汇总（监听 ${LISTEN}s）=====`);
  log(`收到消息 ${total} 条 | 类型分布 ${JSON.stringify(seenTypes)}`);
  log(`\n── 原始样本 ──`);
  rawSamples.forEach((s) => log(`  [${s.type}] ${s.from}: ${s.txt}`));
  log(`\n── 疑似礼物 ${giftMsgs.length} 条 ──`);
  giftMsgs.slice(0, 30).forEach((g) => log(`  [${g.type}] ${g.from}: ${g.txt}`));
  log(`\n含「弦月」：${giftMsgs.filter((g) => g.txt.indexOf('弦月') >= 0).length} 条`);
  try { chatroom.disconnect?.(); } catch (e) { /* ignore */ }
  process.exit(0);
}, LISTEN * 1000);
