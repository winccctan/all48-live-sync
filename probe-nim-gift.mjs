/*
 * 探针 v5：直播间实时消息（网易云信 NIM Chatroom 长连接）。
 *
 * v4 的失败点：用了 Chatroom 专用包 + 顶层 getInstance，登录直接 13_2（非法操作或没有权限）。
 * 补档站已验证的写法是「完整版 SDK + NIMSDK.Chatroom.getInstance」：
 *   const NIMSDK = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');
 *   NIMSDK.Chatroom.getInstance({ appKey, account, token, chatroomId, chatroomAddresses })
 * 而且 chatroomAddresses 必须是自己探过能连的节点：
 *   海外出口 weblink01 常 SSLEOF，weblinkoutsea01 才通；大陆出口反而是 link-ga-hz 更快。
 *
 * 链路：
 *   ① POST /im/api/v1/im/userinfo            → 自己的 NIM 凭证 {accid, pwd}
 *   ② POST /live/api/v1/live/getLiveList {record:false} → 在播场次
 *   ③ POST /live/api/v1/live/getLiveOne {liveId}        → content.roomId（= NIM chatroomId）
 *   ④ 探一条可用 WS 节点 → Chatroom.getInstance 进房 → 监听 message
 *
 * 只回答一个问题：直播间到底有没有「弦月回响」，实时能不能收到。不上报。
 */
import { createRequire } from 'node:module';
import { postJson } from './lib/api.mjs';

const require = createRequire(import.meta.url);

// Node 的 navigator 是只读 getter，NIM SDK 会写它
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'], onLine: true, appName: 'Netscape', cookieEnabled: true },
    writable: true, configurable: true,
  });
} catch { /* noop */ }
try { if (!globalThis.window) globalThis.window = globalThis; } catch { /* noop */ }
try {
  const xhr2 = require('xhr2');
  if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2;
} catch { /* noop */ }

const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const TOKEN = process.env.POCKET48_TOKEN || '';
const LISTEN = Math.max(20, Number(process.env.NIM_LISTEN || 90));
const log = (...a) => console.log(...a);

// 候选节点：海外 runner 优先 weblinkoutsea01，大陆出口 link-ga-hz 更快
const LINKS = [
  'weblinkoutsea01.netease.im:443',
  'weblink01.netease.im:443',
  'chatweblink01.netease.im:443',
  'link-ga-hz.yunxinfw.com:443',
  'hkpxy0.netease.im:443',
];

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

/** 探一个节点能不能建 WS（6 秒硬超时） */
function probeLink(hostPort) {
  const [host, port] = hostPort.split(':');
  return new Promise((res) => {
    let done = false, ws;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); try { ws && ws.close(); } catch { /* noop */ } res(ok); };
    const t = setTimeout(() => finish(false), 6000);
    try {
      ws = new WebSocket(`wss://${host}:${port || 443}/websocket`);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
    } catch { finish(false); }
  });
}

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
log(`NIM 凭证 accid=${accid} pwd长度=${String(pwd).length}`);

/* ② 在播场次 */
const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
const list = (r && r.content && r.content.liveList) || [];
log(`在播场次 ${list.length} 场`);
if (!list.length) { console.error('现在没有直播，换个时间再跑'); process.exit(0); }
function nick(x) { return (x.userInfo && x.userInfo.nickname) || String(x.liveId); }

/* ③ roomId */
const rooms = [];
for (const x of list) {
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: String(x.liveId) }, { token: TOKEN, retries: 1 });
    const c = (d && d.content) || {};
    if (c.roomId) {
      rooms.push({ liveId: String(x.liveId), roomId: Number(c.roomId), nick: nick(x), online: Number(c.onlineNum) || 0 });
    }
  } catch (e) { /* 单场失败不影响 */ }
}
log(`有 roomId 的 ${rooms.length} 场`);
if (!rooms.length) { console.error('没有可进的直播间'); process.exit(0); }
rooms.sort((a, b) => b.online - a.online);
log('取在线最高的 3 场：' + JSON.stringify(rooms.slice(0, 3)));

/* ④ 探节点 */
let picked = '';
const linkResults = [];
for (const l of LINKS) {
  const ok = await probeLink(l);
  linkResults.push(l + '=' + (ok ? 'OK' : '×'));
  if (ok && !picked) picked = l;
}
log('节点探测：' + linkResults.join('  '));
if (!picked) {
  console.error('❌ 所有节点都连不上 WS —— 这台机器的出口被墙/被限，NIM 长连走不通');
  process.exit(1);
}
log(`选用节点 ${picked}`);

/* ⑤ 进房监听 */
let NIMSDK;
try {
  // 🔴 必须是完整版 SDK：Chatroom 专用包在本项目里登录被拒（13_2）
  NIMSDK = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');
} catch (e) {
  console.error('加载 NIM SDK 失败：' + String(e.message).slice(0, 200));
  process.exit(1);
}
if (!NIMSDK.Chatroom) { console.error('SDK 未导出 Chatroom'); process.exit(1); }

const target = rooms[0];
log(`\n进入直播间：${target.nick}  chatroomId=${target.roomId}  在线 ${target.online}`);

let total = 0;
const seenTypes = {};
const giftHits = [];
const samples = [];
let connected = false;

const chatroom = NIMSDK.Chatroom.getInstance({
  appKey: APPKEY,
  account: accid,
  token: pwd,
  chatroomId: target.roomId,
  chatroomAddresses: [picked],
  db: false,
  onconnect() { connected = true; log('✅ 已连上 NIM 聊天室'); },
  onerror(e) { log('⚠️ NIM 错误：' + ((e && (e.message || e.code)) || JSON.stringify(e))); },
  onwillreconnect() { log('↻ 正在重连'); },
  ondisconnect(e) { log('⚠️ 断开：' + ((e && (e.code)) || e)); },
});

function textOf(m) {
  if (typeof m.text === 'string' && m.text) return m.text;
  if (typeof m.content === 'string' && m.content) return m.content;
  if (m.content) { try { return JSON.stringify(m.content); } catch { return ''; } }
  return '';
}
function onMsg(m) {
  if (!m) return;
  total++;
  const type = String(m.type || 'unknown');
  seenTypes[type] = (seenTypes[type] || 0) + 1;
  const from = m.fromNick || m.from || '?';
  const txt = textOf(m);
  if (samples.length < 15) samples.push({ type, from, txt: txt.slice(0, 200) });
  // 口袋直播间的自定义消息里，礼物一般带 gift / 送给 / giftId
  if (/gift|礼物|送给|弦月/i.test(txt) || /gift/i.test(type)) {
    giftHits.push({ type, from, txt: txt.slice(0, 400) });
    if (giftHits.length <= 25) log(`  🎁 [${type}] ${from}: ${txt.slice(0, 200)}`);
  }
}
for (const ev of ['message', 'ChatroomMessage', 'chatroomMessage']) {
  try { chatroom.on?.(ev, (m) => { if (ev === 'message') onMsg(m); }); } catch { /* noop */ }
}
try { chatroom.on?.('connect', () => { if (!connected) { connected = true; log('✅ 已连上（connect 事件）'); } }); } catch { /* noop */ }

setTimeout(() => {
  log(`\n===== 汇总（监听 ${LISTEN}s）=====`);
  log(`连上=${connected} | 收到消息 ${total} 条 | 类型分布 ${JSON.stringify(seenTypes)}`);
  log('── 原始样本 ──');
  samples.forEach((s) => log(`  [${s.type}] ${s.from}: ${s.txt}`));
  log(`── 疑似礼物 ${giftHits.length} 条 ──`);
  giftHits.slice(0, 20).forEach((g) => log(`  [${g.type}] ${g.from}: ${g.txt}`));
  log(`含「弦月」：${giftHits.filter((g) => g.txt.indexOf('弦月') >= 0).length} 条`);
  try { chatroom.disconnect?.(); } catch { /* noop */ }
  process.exit(0);
}, LISTEN * 1000);
