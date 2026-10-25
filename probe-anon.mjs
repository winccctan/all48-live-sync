/**
 * 游客模式进直播间（对照 qqtools 的实现）
 *
 * qqtools NimChatroomSocket.ts 的关键差异：
 *   ① 匿名：{ isAnonymous: true, chatroomNick: randomUUID(), chatroomAvatar: '' }
 *      —— 完全不需要 accid / token
 *   ② 回调是 onmsgs（复数，收数组），不是 onmsg
 *   ③ chatroomAddresses 固定用 chatweblink01.netease.im:443
 *
 * 用法：NICK=康楚翊 SEC=45 node probe-anon.mjs
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { postJson } from './lib/api.mjs';
import { installProxyWebSocket, proxyWsSnapshot } from './lib/ws-proxy.mjs';

const require = createRequire(import.meta.url);

try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Linux x86_64', language: 'zh-CN', languages: ['zh-CN'],
      onLine: true, appName: 'Netscape', cookieEnabled: true,
    },
    writable: true, configurable: true,
  });
} catch {}
try { if (!globalThis.window) globalThis.window = globalThis; } catch {}
try { const xhr2 = require('xhr2'); if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2; } catch {}

process.on('uncaughtException', (e) => console.log('[uncaught]', String(e && e.message).slice(0, 160)));
process.on('unhandledRejection', (e) => console.log('[reject]', String(e && e.message).slice(0, 160)));

const TOKEN = process.env.POCKET48_TOKEN || '';
const APPKEY = '632feff1f4c838541ab75195d1ceb3fa';
const WANT = process.env.NICK || '康楚翊';
const SEC = Math.max(20, Number(process.env.SEC || 45));
const ANON = process.env.ANON !== '0';
const ADDR = process.env.ADDR || 'chatweblink01.netease.im:443';
const PROXY_URL = (process.env.NIM_PROXY || (process.env.USE_PROXY === '1' ? (process.env.SCRAPE_PROXY || '') : ''))
  .split(',').map((s) => s.trim()).filter(Boolean)[0];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (PROXY_URL) installProxyWebSocket(PROXY_URL, (m) => log('[ws]', m));

// 拿 roomId
const lr = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
const list = (lr.content && lr.content.liveList) || [];
const s = list.find((x) => String((x.userInfo && x.userInfo.nickname) || '').includes(WANT)) || list[0];
if (!s) { console.error('没有在播场次'); process.exit(1); }
const nick = String((s.userInfo && s.userInfo.nickname) || s.liveId);
const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 2 })).content || {};
log(`选中 ${nick} liveId=${s.liveId} roomId=${one.roomId} 模式=${ANON ? '游客' : '账号'}`);

let accid = '', pwd = '';
if (!ANON) {
  const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN });
  const c = (info && info.content) || {};
  accid = String(c.accid || ''); pwd = String(c.pwd || '');
}

const sdk = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');
let msgs = 0, connects = 0;
const t0 = Date.now();

const opts = {
  appKey: APPKEY,
  chatroomId: String(one.roomId),
  chatroomAddresses: [ADDR],
  db: false,
  onconnect() { connects++; log(`✅ onconnect（+${Math.round((Date.now() - t0) / 1000)}s）`); },
  onmsgs(arr) {
    const n = Array.isArray(arr) ? arr.length : 1;
    msgs += n;
    if (msgs <= 5) log(`📨 收到 ${n} 条`, JSON.stringify((Array.isArray(arr) ? arr[0] : arr) || {}).slice(0, 220));
  },
  onmsg(m) { msgs++; if (msgs <= 3) log('📨(onmsg)', JSON.stringify(m || {}).slice(0, 200)); },
  onwillreconnect() { log('↻ onwillreconnect'); },
  ondisconnect(err) { log('⚠️ ondisconnect', JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 140) })); },
  onerror(err) { log('❗ onerror', JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 140) })); },
};
if (ANON) {
  Object.assign(opts, { isAnonymous: true, chatroomNick: randomUUID(), chatroomAvatar: '' });
} else {
  Object.assign(opts, { account: accid, token: pwd });
}

try {
  sdk.Chatroom.getInstance(opts);
  log('getInstance 返回，等回调…');
} catch (e) {
  log('❌ getInstance 抛错：' + String(e.message).slice(0, 200));
}

setTimeout(() => {
  log(`\n结果：connects=${connects} msgs=${msgs}`);
  log('WS 统计：', JSON.stringify(proxyWsSnapshot()));
  process.exit(0);
}, SEC * 1000);
