import fs from 'fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { NimCommonlinkChatroomClient } = require('./nim-client/chatroom.cjs');
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const APP_KEY = '632feff1f4c838541ab75195d1ceb3fa';
const appInfo = JSON.stringify({ vendor:'apple', deviceId:'7B93DFD0-472F-4736-A628-E85FAE086486', appVersion:'7.0.41', appBuild:'24011601', osVersion:'16.3.1', osType:'ios', deviceName:'iPhone XR', os:'ios' });
const H = { 'Content-Type':'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(), 'Accept-Language':'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' };
const pocket = async (p, b) => (await (await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) })).json());
const creds = (await pocket('/im/api/v1/im/userinfo', {}))?.content || {};
console.log('accid', creds.accid || creds.accId, 'pwd?', !!(creds.pwd || creds.token));
const SEA = +(process.env.SEC || 75);
const list = (await pocket('/live/api/v1/live/getLiveList', { debug: false, next: '0', groupId: 0, record: false }))?.content?.liveList || [];
console.log('在播', list.length);
const types = new Map();
const cmdMap = new Map();
const odd = [];
const samples = [];
let n = 0;
const cl = [];
for (const x of list.slice(0, 6)) {
  const one = (await pocket('/live/api/v1/live/getLiveOne', { liveId: x.liveId }))?.content || {};
  if (!one.roomId) continue;
  const c = new NimCommonlinkChatroomClient({
    appKey: APP_KEY, account: creds.accid || creds.accId, token: creds.pwd || creds.token, roomId: String(one.roomId),
    onConnected() { console.log('连上', one.user?.userName || x.nickname, one.roomId); },
    onRawPacket(pk, via) {
      const k = pk.serviceId + '/' + pk.commandId;
      cmdMap.set(k, (cmdMap.get(k) || 0) + 1);
      if (pk.serviceId !== 13 || ![7, 6, 13].includes(pk.commandId)) {
        if (odd.length < 12) {
          odd.push({ k, via, len: pk.body?.length, hex: Buffer.from(pk.body || []).subarray(0, 120).toString('hex') });
          console.log('[ODD] ' + k + ' via=' + via + ' len=' + (pk.body?.length) + ' ' + Buffer.from(pk.body || []).subarray(0, 60).toString('hex'));
        }
      }
    },
    onMessage(d) {
      n++;
      const t = d.msg_type_;
      types.set(t, (types.get(t) || 0) + 1);
      if (t !== 0 && samples.length < 25) {
        samples.push({ t, from: d.from, nick: d.fromNick, attach: String(d.msg_attach_ || '').slice(0, 200), custom: String(d.custom || '').slice(0, 160), text: String(d.text || '').slice(0, 60) });
        console.log('[非文本] t=' + t, d.fromNick, '|', String(d.msg_attach_ || '').slice(0, 160), '|', String(d.custom || '').slice(0, 120));
      }
    },
    onError(e) { console.log('err', e?.message || e); },
  });
  cl.push(c);
  c.connect().catch((e) => console.log('connect fail', e?.message || e));
  await new Promise((r) => setTimeout(r, 250));
}
await new Promise((r) => setTimeout(r, SEA * 1000));
console.log('STATS ' + JSON.stringify({ n, types: [...types.entries()].sort((a, b) => b[1] - a[1]) }));
console.log('CMDS ' + JSON.stringify([...cmdMap.entries()].sort((a,b)=>b[1]-a[1])));
console.log('ODD ' + JSON.stringify(odd));
fs.writeFileSync('/tmp/chat-samples.json', JSON.stringify(samples, null, 1));
for (const c of cl) { try { c.destroy?.(); } catch {} }
process.exit(0);
