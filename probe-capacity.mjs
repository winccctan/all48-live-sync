/**
 * 容量实测：单个 accid 同时进 N 个直播间，看几个能真正「连上并保持」。
 * 这决定架构：N 够大 ⇒ 降配就行；N 到某个数就开始掉 ⇒ 必须多账号分片。
 *
 * 用法：N=12 SEC=100 node probe-capacity.mjs
 */
import { createRequire } from 'node:module';
import { postJson } from './lib/api.mjs';
import { installProxyWebSocket } from './lib/ws-proxy.mjs';

const require = createRequire(import.meta.url);

// 🔴 NIM SDK 会写 navigator / window / XMLHttpRequest：
//    Node 22 的 globalThis.navigator 只有 getter ⇒ autoPolyfill 赋值直接
//    "Cannot set property navigator of #<Object> which has only a getter"。
//    必须在这里用 defineProperty 覆盖成可写，且要在 require SDK 之前。
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Linux x86_64', language: 'zh-CN', languages: ['zh-CN'],
      onLine: true, appName: 'Netscape', cookieEnabled: true,
    },
    writable: true, configurable: true,
  });
} catch { /* noop */ }
try { if (!globalThis.window) globalThis.window = globalThis; } catch { /* noop */ }
try {
  const xhr2 = require('xhr2');
  if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2;
} catch { /* noop */ }
const N = Math.max(1, Number(process.env.N || 12));
const SEC = Math.max(20, Number(process.env.SEC || 100));
const TOKEN = process.env.POCKET48_TOKEN || '';
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const PROXY_URL = (process.env.NIM_PROXY || (process.env.USE_PROXY === '1' ? (process.env.SCRAPE_PROXY || '') : ''))
  .split(',').map((s) => s.trim()).filter(Boolean)[0];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (PROXY_URL) { installProxyWebSocket(PROXY_URL, (m) => log('[ws]', m)); }

const LINKS = ['weblink01.netease.im:443', 'chatweblink01.netease.im:443', 'hkpxy0.netease.im:443', 'weblinkoutsea01.netease.im:443'];

function probeLink(hp) {
  const [host, port] = hp.split(':');
  return new Promise((resolve) => {
    let done = false, ws;
    const fin = (ok) => { if (done) return; done = true; clearTimeout(timer); try { ws && ws.close(); } catch {} resolve(ok); };
    const timer = setTimeout(() => fin(false), 6000);
    try { ws = new WebSocket(`wss://${host}:${port || 443}/websocket`); ws.onopen = () => fin(true); ws.onerror = () => fin(false); } catch { fin(false); }
  });
}

let link = '';
for (const l of LINKS) { if (await probeLink(l)) { link = l; break; } }
log('节点 ⇒', link || '（探测全失败，让 SDK 自己选）');

// ① accid
const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN });
const c = info.content || {};
const accid = String(c.accid || '');
const pwd = String(c.pwd || '');          // 🔴 必须是 content.pwd，不是 token（取错就是连不上）
log('accid =', accid ? accid.slice(0, 6) + '***' : '（空）');
if (!accid || !pwd) { console.error('拿不到 accid/pwd：', JSON.stringify(c).slice(0, 200)); process.exit(1); }

// ② 在播场次，按在线人数取前 N
const lr = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
const list = ((lr.content && lr.content.liveList) || []).slice();
list.sort((a, b) => (Number(b.onlineNum) || 0) - (Number(a.onlineNum) || 0));
const picked = list.slice(0, N);
log(`在播 ${list.length} 场，取前 ${picked.length} 场`);

const sdk = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');
const slots = [];

for (const s of picked) {
  const nick = String((s.userInfo && s.userInfo.nickname) || s.liveId);
  let roomId = 0;
  try {
    const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 2 })).content || {};
    roomId = Number(one.roomId) || 0;
  } catch {}
  if (!roomId) { log(`·  ${nick} 无 roomId（跳过）`); continue; }
  const slot = { nick, roomId, state: 'init', msgs: 0, connects: 0, drops: 0, chatroom: null };
  slots.push(slot);
  try {
    slot.chatroom = sdk.Chatroom.getInstance({
      appKey: APPKEY, account: accid, token: pwd, chatroomId: roomId,
      chatroomAddresses: link ? [link] : undefined, db: false,
      onmsg() { slot.msgs++; },
      onconnect() { slot.state = 'on'; slot.connects++; },
      ondisconnect(err) { slot.drops++; slot.state = 'down'; slot.err = (err && (err.code || err.message)) || '?'; },
      onerror(err) { if (!slot.err) slot.err = 'err:' + ((err && (err.code || err.message)) || '?'); },
    });
    slot.state = 'entering';
  } catch (e) { slot.state = 'err'; log(`×  ${nick} 建实例失败 ${String(e.message).slice(0, 60)}`); }
}

log(`已发起 ${slots.length} 个房间的进房请求，观察 ${SEC}s`);

const t0 = Date.now();
const tick = setInterval(() => {
  const on = slots.filter((s) => s.state === 'on').length;
  const down = slots.filter((s) => s.state === 'down').length;
  const entering = slots.filter((s) => s.state === 'entering' || s.state === 'init').length;
  const msgs = slots.reduce((a, s) => a + s.msgs, 0);
  log(`[${Math.round((Date.now() - t0) / 1000)}s] on=${on} down=${down} entering=${entering} msgs=${msgs}`);
}, 20000);

await new Promise((r) => setTimeout(r, SEC * 1000));
clearInterval(tick);

console.log('\n=== 逐房间结果 ===');
for (const s of slots.sort((a, b) => b.msgs - a.msgs)) {
  console.log(`  ${s.state === 'on' ? '✅' : s.state === 'down' ? '❌' : '·'} ${s.nick.padEnd(14)} state=${s.state.padEnd(8)} msgs=${String(s.msgs).padStart(3)} 连接${s.connects}次 掉线${s.drops}次 ${s.err ? 'err=' + s.err : ''}`);
}
const onN = slots.filter((s) => s.state === 'on').length;
console.log(`\n结论：发起 ${slots.length} 个，最后仍连通 ${onN} 个（${((onN / slots.length) * 100).toFixed(0)}%），总消息 ${slots.reduce((a, s) => a + s.msgs, 0)} 条`);
process.exit(0);
