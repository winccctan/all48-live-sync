/**
 * 实测：同一个 accid 同时进 N 个聊天室，云信能扛几条？会不会互踢？
 *
 * 为什么可以现在测：虽然当前 0 场在播，但可以拿**刚下播**的房间当靶子
 * （下播后聊天室不一定立刻销毁，进得去就能验证互踢行为）。
 *
 * 输出：每个实例的 state（on/被踢/错误），以及「同时在线的最大条数」。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { postJson } from '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/lib/api.mjs';
import { installProxyWebSocket } from '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/lib/ws-proxy.mjs';

const require = createRequire(import.meta.url);

try {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'MacIntel', language: 'zh-CN', languages: ['zh-CN'], onLine: true, appName: 'Netscape', cookieEnabled: true,
    },
    writable: true, configurable: true,
  });
} catch { /* noop */ }
try { if (!globalThis.window) globalThis.window = globalThis; } catch { /* noop */ }
try { const xhr2 = require('xhr2'); if (typeof globalThis.XMLHttpRequest === 'undefined') globalThis.XMLHttpRequest = xhr2; } catch { /* noop */ }

// 🔴 installProxyWebSocket 只吃单个 URL，多代理要自己取第一个（生产代码也是 split(',')[0]）
installProxyWebSocket(String(process.env.SCRAPE_PROXY || '').split(',')[0].trim(), (...a) => console.log('[ws]', ...a));

const env = Object.fromEntries(
  fs.readFileSync('/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/nim-sync.env', 'utf8')
    .split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const TOKEN = env.POCKET48_TOKEN;
const APPKEY = '632feff1f4c838541ab75195d1ceb3fa';
const LINK = process.env.NIM_LINK || 'weblink01.netease.im:443';
const N = Number(process.env.N || 20);
const HOLD = Number(process.env.HOLD || 90);   // 保持多少秒观察互踢

const NIMSDK = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');

// 取 NIM 凭证
const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN });
const accid = info.content.accid;
const pwd = info.content.pwd;
console.log(`accid=${accid}`);

// 取 N 个最近的房间（含已下播）
const listR = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: true }, { token: TOKEN });
const lives = (listR.content.liveList || []).slice(0, N + 5);
const rooms = [];
for (const x of lives) {
  if (rooms.length >= N) break;
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: String(x.liveId) }, { token: TOKEN, retries: 1 });
    const rid = Number((d.content && d.content.roomId) || 0);
    if (rid) rooms.push({ rid, nick: x.userInfo?.nickname || '?', status: x.status });
  } catch { /* skip */ }
  await new Promise((r) => setTimeout(r, 200));
}
console.log(`拿到 ${rooms.length} 个 roomId，准备同时进房`);

const inst = [];       // {rid,nick,state,seq}
let seq = 0;
function open(r) {
  const me = { rid: r.rid, nick: r.nick, state: 'entering', at: Date.now() };
  inst.push(me);
  try {
    const cr = NIMSDK.Chatroom.getInstance({
      appKey: APPKEY, account: accid, token: pwd, chatroomId: r.rid,
      chatroomAddresses: [LINK], db: false,
      onmsg() { me.msgs = (me.msgs || 0) + 1; },
      onconnect() {
        const n = inst.filter((x) => x.state === 'on').length + 1;
        me.state = 'on';
        console.log(`  ✅ #${++seq} ${r.nick} 进房成功（此刻 on=${n}）`);
      },
      ondisconnect(err) {
        const code = (err && (err.code || err.message)) || '';
        me.state = 'down';
        me.code = String(code);
        console.log(`  ❌ ${r.nick} 断开 code=${code}`);
      },
      onerror(err) { me.err = String((err && (err.message || err.code)) || ''); },
    });
    me.cr = cr;
  } catch (e) {
    me.state = 'throw';
    me.err = String(e.message).slice(0, 120);
  }
}

// 依次开，间隔 350ms（和生产一致）
for (const r of rooms) {
  open(r);
  await new Promise((res) => setTimeout(res, 350));
}

console.log(`\n全部开完，保持 ${HOLD}s 观察互踢...`);
await new Promise((res) => setTimeout(res, HOLD * 1000));

const on = inst.filter((x) => x.state === 'on');
console.log(`\n===== 结果：${inst.length} 个实例，仍在线 ${on.length} 个 =====`);
const by = {};
for (const x of inst) by[x.state] = (by[x.state] || 0) + 1;
console.log('状态分布:', JSON.stringify(by));
console.log('断开 code 分布:', JSON.stringify(inst.filter((x) => x.code).reduce((a, x) => (a[x.code] = (a[x.code] || 0) + 1, a), {})));
for (const x of inst) console.log(`  ${x.state.padEnd(8)} room=${x.rid} ${x.nick} ${x.err || x.code || ''}`);

for (const x of inst) { try { x.cr && x.cr.disconnect(); } catch { /* noop */ } }
process.exit(0);
