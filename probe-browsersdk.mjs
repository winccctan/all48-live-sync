/**
 * 用「浏览器版」NIM_Web_SDK.js 在 Node 里跑（shim window/navigator/WebSocket）。
 * 目的：验证 403 是否是「nodejs 构建把平台标识报成 node」导致的。
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const SDK_PATH = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/node_modules/@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK.js';

// ---- shims ----
globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'],
    onLine: true, appName: 'Netscape', cookieEnabled: true,
  },
  writable: true, configurable: true,
});
if (!globalThis.document) {
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {},
    getElementsByTagName: () => [],
    documentElement: { style: {} },
    visibilityState: 'visible',
  };
}
globalThis.localStorage = {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
try { const xhr2 = require('xhr2'); if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2; } catch (e) { console.log('xhr2 缺失', e.message); }

process.on('uncaughtException', (e) => console.log('[uncaught]', String(e && e.message).slice(0, 200)));
process.on('unhandledRejection', (e) => console.log('[reject]', String(e && e.message).slice(0, 200)));

const mod = require(SDK_PATH);
const NIM = mod && mod.SDK ? mod.SDK : mod;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
log('SDK 加载，NIM keys =', Object.keys(NIM || {}).join(','));
if (!NIM || !NIM.Chatroom) { console.error('没有 Chatroom'); process.exit(1); }

const APPKEY = '632feff1f4c838541ab75195d1ceb3fa';
const roomId = Number(process.env.ROOM || 4512384734);
const ADDR = process.env.ADDR || 'chatweblink01.netease.im:443';
const t0 = Date.now();
let msgs = 0;

const opts = {
  appKey: APPKEY,
  chatroomId: roomId,
  chatroomAddresses: [ADDR],
  db: false,
  dbLog: false,
  isAnonymous: true,
  chatroomNick: randomUUID(),
  chatroomAvatar: '',
  onconnect(e) { log('✅ onconnect  +' + ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(e && { code: e.code }).slice(0, 80)); },
  onmsgs(arr) {
    msgs += (arr || []).length;
    (arr || []).slice(0, 3).forEach((m) => log('📨', String(m.fromNick || m.from || '').slice(0, 16), ':', String(m.text || m.content || '').slice(0, 110)));
  },
  onerror(err) { log('❗ onerror', JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 140) })); },
  ondisconnect(err) { log('⚠️ ondisconnect +' + ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 140) })); },
  onwillreconnect() { log('↻ onwillreconnect'); },
};

try {
  NIM.Chatroom.getInstance(opts);
  log('getInstance 已返回，等待回调…');
} catch (e) {
  log('❌ 抛错', String(e.message).slice(0, 200));
  process.exit(1);
}

setTimeout(() => { log('结果：msgs =', msgs); process.exit(0); }, Number(process.env.SEC || 25) * 1000);
