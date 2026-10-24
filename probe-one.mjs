/**
 * 单房间最小复现：进 1 个直播间，把 SDK 的每一步回调都打出来（含断开码）。
 * 进程级异常也捕获，不让 ECONNRESET 把输出吞掉。
 *
 * 用法：NICK=康楚翊 node probe-one.mjs
 */
import { createRequire } from 'node:module';
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

process.on('uncaughtException', (e) => console.log('[uncaught]', String(e && e.message).slice(0, 200)));
process.on('unhandledRejection', (e) => console.log('[reject]', String(e && e.message).slice(0, 200)));

const TOKEN = process.env.POCKET48_TOKEN || '';
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const WANT = process.env.NICK || '康楚翊';
const SEC = Math.max(20, Number(process.env.SEC || 60));
const PROXY_URL = (process.env.NIM_PROXY || (process.env.USE_PROXY === '1' ? (process.env.SCRAPE_PROXY || '') : ''))
  .split(',').map((s) => s.trim()).filter(Boolean)[0];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (PROXY_URL) installProxyWebSocket(PROXY_URL, (m) => log('[ws]', m));

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
for (const l of LINKS) if (await probeLink(l)) { link = l; break; }
log('节点 ⇒', link || '（无）');

const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN });
const c = (info && info.content) || {};
const accid = String(c.accid || '');
const pwd = String(c.pwd || '');
log('accid=', accid || '空', 'pwd长度=', pwd.length, '字段=', Object.keys(c).join(','));

const lr = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
const list = (lr.content && lr.content.liveList) || [];
const s = list.find((x) => String((x.userInfo && x.userInfo.nickname) || '').includes(WANT)) || list[0];
if (!s) { console.error('没有在播场次'); process.exit(1); }
const nick = String((s.userInfo && s.userInfo.nickname) || s.liveId);
const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 2 })).content || {};
log(`选中 ${nick} liveId=${s.liveId} roomId=${one.roomId}`);

const sdk = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');
log('SDK 已加载，Chatroom 存在=', !!sdk.Chatroom);

let msgs = 0, connects = 0;
const t0 = Date.now();
try {
  const cr = sdk.Chatroom.getInstance({
    appKey: APPKEY, account: accid, token: pwd, chatroomId: Number(one.roomId),
    chatroomAddresses: link ? [link] : undefined, db: false,
    onconnect() { connects++; log(`✅ onconnect 第${connects}次（+${Math.round((Date.now() - t0) / 1000)}s）`); },
    onmsg(m) {
      msgs++;
      if (msgs <= 3) log('📨', String(m && (m.text || m.type)).slice(0, 100));
    },
    onwillreconnect() { log('↻ onwillreconnect'); },
    ondisconnect(err) { log('⚠️ ondisconnect', JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 120) })); },
    onerror(err) { log('❗ onerror', JSON.stringify(err && { code: err.code, message: String(err.message || '').slice(0, 120) })); },
  });
  log('getInstance 返回，等回调…');
  setTimeout(() => {
    log(`结果：connects=${connects} msgs=${msgs}`);
    log('WS 统计：', JSON.stringify(proxyWsSnapshot()));
    process.exit(0);
  }, SEC * 1000);
} catch (e) {
  log('❌ getInstance 抛错：' + String(e.message).slice(0, 200));
  process.exit(1);
}
