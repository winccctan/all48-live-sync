/**
 * 聊天室登录矩阵测试：13_2 是「chatroom login」命令，403 = 登录策略拒绝。
 * 这里穷举几组可能的“房票”来源，看哪一组能过。
 *
 * 用法：node probe-matrix.mjs
 */
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { postJson } from './lib/api.mjs';

const require = createRequire(import.meta.url);
const SDK_PATH = './node_modules/@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK.js';

globalThis.window = globalThis;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    platform: 'iPhone', language: 'zh-CN', languages: ['zh-CN'],
    onLine: true, appName: 'Netscape', cookieEnabled: true,
  },
  writable: true, configurable: true,
});
if (!globalThis.document) {
  globalThis.document = {
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }),
    addEventListener() {}, removeEventListener() {}, getElementsByTagName: () => [],
    documentElement: { style: {} }, visibilityState: 'visible',
  };
}
globalThis.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
try { const xhr2 = require('xhr2'); if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2; } catch {}

process.on('uncaughtException', (e) => console.log('[uncaught]', String(e && e.message).slice(0, 160)));
process.on('unhandledRejection', (e) => console.log('[reject]', String(e && e.message).slice(0, 160)));

const NIM = (() => { const m = require(SDK_PATH); return m && m.SDK ? m.SDK : m; })();
const APPKEY = '632feff1f4c838541ab75195d1ceb3fa';
const T = process.env.POCKET48_TOKEN || process.env.TOKEN || '';

const lr = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: T, retries: 3 });
const list = lr.content?.liveList || [];
const s = list.find((x) => /龚晨美|王艺霖/.test(String(x.userInfo?.nickname || ''))) || list[0];
if (!s) { console.error('无在播'); process.exit(1); }
const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: T, retries: 3 })).content || {};
const info = (await postJson('/im/api/v1/im/userinfo', {}, { token: T, retries: 3 })).content || {};
const roomId = Number(one.roomId);
const accid = String(info.accid || '');
const pwd = String(info.pwd || '');
console.log(`目标 ${s.userInfo?.nickname} roomId=${roomId} accid=${accid} crm=${one.crm}`);

const CASES = [
  { name: 'A 匿名(随机昵称)', opts: { isAnonymous: true, chatroomNick: randomUUID() } },
  { name: 'B 匿名(昵称=账号昵称)', opts: { isAnonymous: true, chatroomNick: String(s.userInfo?.nickname || 'fans') } },
  { name: 'C 账号+accid/pwd', opts: { account: accid, token: pwd } },
  { name: 'D 账号+accid/pwd+昵称', opts: { account: accid, token: pwd, chatroomNick: String(s.userInfo?.nickname || 'fans') } },
  { name: 'E 匿名+token=crm', opts: { isAnonymous: true, chatroomNick: randomUUID(), token: String(one.crm || '') } },
  { name: 'F 账号+token=crm', opts: { account: accid, token: String(one.crm || ''), chatroomNick: String(s.userInfo?.nickname || 'fans') } },
];

async function tryCase(c, i) {
  return new Promise((resolve) => {
    let done = false;
    const t0 = Date.now();
    let cr;
    const fin = (msg) => {
      if (done) return; done = true;
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [${c.name}] ${msg}  (${dt}s)`);
      try { cr && cr.disconnect && cr.disconnect({ done() {} }); } catch {}
      setTimeout(resolve, 1200);
    };
    try {
      cr = NIM.Chatroom.getInstance({
        appKey: APPKEY,
        chatroomId: roomId,
        chatroomAddresses: ['chatweblink01.netease.im:443'],
        db: false, dbLog: false,
        ...c.opts,
        onconnect() { fin('✅ 成功连上'); },
        onmsgs() {},
        onerror(err, e) { fin('❗ onerror ' + JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 90) })); },
        ondisconnect(err) { fin('⚠️ 断开 ' + JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 90) })); },
      });
    } catch (e) {
      fin('❌ 抛错 ' + String(e.message).slice(0, 120));
    }
    setTimeout(() => fin('⏱ 超时（无回调）'), 12000);
  });
}

for (let i = 0; i < CASES.length; i++) {
  console.log(`\n== 用例 ${i + 1}/${CASES.length} ==`);
  await tryCase(CASES[i], i);
}
console.log('\n全部用例结束');
process.exit(0);
