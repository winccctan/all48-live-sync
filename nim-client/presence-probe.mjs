/**
 * 云信「在线状态事件订阅」协议探针 —— 纯本地，不写库、不发消息、不改任何线上代码。
 *
 * 🔴 协议依据（2026-11-13 从官方 Web SDK 9.21.18 源码解出，非猜测）：
 *   cmdConfig.eventService = { id:14, publishEvent:1, pushEvent:2, subscribeEvent:3,
 *       unSubscribeEventsByAccounts:4, unSubscribeEventsByType:5,
 *       querySubscribeEventsByAccounts:6, querySubscribeEventsByType:7, pushEvents:9 }
 *   subscribeEvent.params = [ Property(msgEventSubscribe), StrArray(accounts) ]
 *   serializeMap.msgEventSubscribe = { type:1, subscribeTime:2, sync:3, to:102, from:104, time:105 }
 *   MsgEventSubscribe 默认 { type:1, subscribeTime:2592000(30天), sync:1 }
 *   marshal(e, params) 按 params 顺序依次写值 → body = Property + StrArray，中间无字段号
 *   marshalProperty  = varint(count) + [varint(key), varint(len), utf8(value)]
 *   marshalStrArray  = varint(count) + [varint(len), utf8(value)]
 *   ⇒ 与本项目 qchat.cjs 的 encodeProperties / decodeProperties 字节格式完全一致
 *   14/3 响应 = StrArray(accounts)，SDK 把它当 failedAccounts
 *   14/2 推送 = Property(msgEvent)；14/9 推送 = PropertyArray(msgEvents)
 *   msgEvent 字段 { type:1, value:2, ... time:10, account:103, ... }；value 1=上线 2=登出 3=断开
 *
 * 🔴 旧结论作废：上一版探针发的是 14/1（publishEvent）空包，回 403 只是「参数不对」。
 *    对照扫描证明 9/1、15/1、21/1 空包同样 403，24/1 空包 500、带正确 body 才 200。
 *
 * 用法：
 *   cd all48-live-sync
 *   set -a && source ./nim-sync.env && set +a
 *   env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY node nim-client/presence-probe.mjs
 *
 * 环境变量：
 *   POCKET48_TOKEN   主号，走 /im/api/v1/im/userinfo 现换 accid/pwd（优先）
 *   PROBE_USE_ENV=1  强制用 env 里已有云信凭据
 *   PROBE_DEBUG=1    打印每个包明细
 *   PROBE_SEC        观察秒数，默认 30
 *   PROBE_ROOMS      订阅房间数，默认 10（顺带采 fromAccount）
 *   PROBE_ACCOUNTS   逗号分隔的订阅目标 accid；默认「自己 + 二号 + 采样到的 fromAccount」
 *   PROBE_SCAN=1     额外跑服务号空包对照扫描
 *   PROBE_VARIANTS=1 额外试几种 body 变体（诊断用，会重复订阅）
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { createNimCommonlinkQChatClient, encodeProperties } = require('./qchat.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const APP_KEY = '632feff1f4c838541ab75195d1ceb3fa';
const SECONDS = Math.max(5, Number(process.env.PROBE_SEC || 30));
const ROOM_N = Math.max(0, Number(process.env.PROBE_ROOMS || 10));
const DEBUG = process.env.PROBE_DEBUG === '1';

const ts = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19);
const log = (...a) => console.log(`[${ts()}]`, ...a);

function envVal(file, key) {
  const txt = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const m = new RegExp('^' + key + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

/* ---------- 与 SDK marshalProperty / marshalStrArray 等价的本地编码 ---------- */
function varint(n) {
  const out = [];
  let v = Number(n) >>> 0;
  do { let b = v & 0x7f; v = Math.floor(v / 128); if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}
function readVarint(buf, off = 0) {
  let v = 0, scale = 1;
  for (let i = off; i < buf.length && i < off + 5; i++) {
    const b = buf[i]; v += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return { value: v, size: i - off + 1 };
    scale *= 128;
  }
  return null;
}
function strArrayBuf(values) {
  const arr = [...new Set(values.map(String).filter(Boolean))];
  const chunks = [varint(arr.length)];
  for (const v of arr) { const b = Buffer.from(v, 'utf8'); chunks.push(varint(b.length), b); }
  return Buffer.concat(chunks);
}
function decodeStrArray(buf) {
  let off = 0; const c = readVarint(buf, off); if (!c) return null;
  off += c.size; const out = [];
  for (let i = 0; i < c.value; i++) {
    const l = readVarint(buf, off); if (!l) return null;
    off += l.size;
    if (off + l.value > buf.length) return null;
    out.push(buf.subarray(off, off + l.value).toString('utf8'));
    off += l.value;
  }
  return { values: out, offset: off };
}
function decodeProps(buf) {
  let off = 0; const c = readVarint(buf, off); if (!c) return null;
  off += c.size; const map = new Map();
  for (let i = 0; i < c.value; i++) {
    const k = readVarint(buf, off); if (!k) return null; off += k.size;
    const l = readVarint(buf, off); if (!l) return null; off += l.size;
    if (off + l.value > buf.length) return null;
    map.set(k.value, buf.subarray(off, off + l.value).toString('utf8'));
    off += l.value;
  }
  return { map, offset: off };
}
/** 14/3、14/6 请求体 = Property(msgEventSubscribe) + StrArray(accounts) */
function subscribeBody(accounts, { type = 1, subscribeTime = 2592000, sync = 1 } = {}) {
  return Buffer.concat([
    encodeProperties({ 1: String(type), 2: String(subscribeTime), 3: String(sync) }),
    strArrayBuf(accounts),
  ]);
}
const EVENT_VALUE = { 1: '上线', 2: '登出', 3: '断连' };
function describeEvent(map) {
  const account = map.get(103) || map.get('103') || '';
  return `type=${map.get(1) || ''} value=${map.get(2) || ''}(${EVENT_VALUE[Number(map.get(2))] || '自定义'}) ` +
    `account=${account} time=${map.get(10) || ''} clientType=${map.get(12) || ''}`;
}

/* ---------- 凭据 ---------- */
async function credential() {
  if (process.env.PROBE_USE_ENV === '1') {
    const a = String(process.env.NIM_ACCID || process.env.NIM2_ACCID || '').trim();
    const t = String(process.env.NIM_PW || process.env.NIM2_PW || '').trim();
    if (a && t) return { account: a, token: t, from: 'env(强制)' };
  }
  const p48 = process.env.POCKET48_TOKEN || envVal(resolve(ROOT, 'nim-sync.env'), 'POCKET48_TOKEN');
  if (p48) {
    try {
      const { generatePa } = await import('./pa.mjs');
      const appInfo = JSON.stringify({
        vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
        appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
        osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
      });
      const r = await fetch('https://pocketapi.48.cn/im/api/v1/im/userinfo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf-8', appInfo,
          'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
          'Accept-Language': 'zh-Hans-CN;q=1', token: p48, pa: generatePa(),
        },
        body: '{}',
      });
      const j = await r.json();
      const c = j?.content || {};
      const a = String(c.accid || c.accId || c.imUserId || '').trim();
      const t = String(c.pwd || c.token || c.imPwd || '').trim();
      if (a && t) return { account: a, token: t, from: 'pocket userinfo(主号)' };
      log('userinfo 没给 accid/pwd：', JSON.stringify(j).slice(0, 220));
    } catch (e) { log('userinfo 换取失败：', String(e.message || e).slice(0, 120)); }
  }
  const a = String(process.env.NIM_ACCID || process.env.NIM2_ACCID || '').trim();
  const t = String(process.env.NIM_PW || process.env.NIM2_PW || '').trim();
  if (a && t) return { account: a, token: t, from: 'env(fallback)' };
  throw new Error('缺凭据：需要 POCKET48_TOKEN 或 NIM_ACCID/NIM_PW');
}

/* ---------- 全包观察 ---------- */
const pktCount = new Map();
const svc14 = [];
const eventPushes = [];
const fromAccounts = new Map();
let cred = null;

function observe(layer, pkt, via) {
  const s = Number(pkt.serviceId), c = Number(pkt.commandId);
  const buf = pkt.body || Buffer.alloc(0);
  if (DEBUG && !(s === 1 && (c === 1 || c === 2))) {
    console.log(`[PKT] ${layer}:${s}/${c} via=${via} code=${pkt.resultCode} serial=${pkt.serial} len=${buf.length} hex=${buf.subarray(0, 40).toString('hex')}`);
  }
  if (s === 1 && (c === 1 || c === 2)) return;
  const k = `${layer}:${s}/${c}`;
  const rec = pktCount.get(k) || { n: 0, codes: new Set() };
  rec.n++; rec.codes.add(pkt.resultCode);
  pktCount.set(k, rec);

  if (s === 14) {
    svc14.push({ layer, via, cmd: c, code: pkt.resultCode, serial: pkt.serial, len: buf.length });
    // 14/2 pushEvent = Property(msgEvent)；14/9 pushEvents = PropertyArray(msgEvents)
    if ((c === 2 || c === 9) && buf.length) {
      try {
        const p = decodeProps(buf);
        if (p) eventPushes.push({ cmd: c, code: pkt.resultCode, text: describeEvent(p.map), raw: [...p.map.entries()] });
      } catch { /* 忽略解析失败 */ }
    }
  }
}

function roomIds() {
  try {
    const txt = readFileSync(resolve(ROOT, '../all48-worker/public/data/members.js'), 'utf8');
    const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    return arr.filter((m) => m && m.srv && String(m.tm || '').indexOf('荣誉') < 0)
      .map((m) => String(m.srv)).filter((s) => /^\d+$/.test(s));
  } catch (e) {
    log('名册读取失败，跳过房间订阅：', String(e.message).slice(0, 80));
    return [];
  }
}

let client = null, credLabel = '', done = false;
const stop = () => {
  if (done) return;
  done = true;
  try { client?.destroy(); } catch { /* noop */ }
  report();
};
process.on('SIGINT', () => { log('收到 Ctrl+C'); stop(); process.exit(0); });

function report() {
  console.log('\n================ 探针结果 ================');
  console.log(`账号: ${credLabel}  观察 ${SECONDS} 秒`);
  console.log('\n-- 收到的包（按 serviceId/commandId 汇总）--');
  const rows = [...pktCount.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [k, v] of rows.slice(0, 40)) console.log(`  ${k.padEnd(20)} n=${String(v.n).padEnd(4)} codes=[${[...v.codes].join(',')}]`);
  if (!rows.length) console.log('  （除握手/心跳外一个包都没有）');

  console.log('\n-- serviceId=14 事件服务包 --');
  if (!svc14.length) console.log('  （无）');
  else for (const p of svc14) console.log(`  ${p.layer}:14/${p.cmd} via=${p.via} code=${p.code} serial=${p.serial} len=${p.len}`);

  console.log('\n-- 14/2、14/9 事件推送解析 --');
  if (!eventPushes.length) console.log('  （无推送）');
  else for (const p of eventPushes) console.log(`  14/${p.cmd} code=${p.code} ${p.text}\n     raw=${JSON.stringify(p.raw).slice(0, 400)}`);

  console.log('\n-- QChat 消息里采到的 fromAccount（可作订阅目标）--');
  if (!fromAccounts.size) console.log('  （观察窗口内没有房间消息）');
  else for (const [a, v] of fromAccounts) console.log(`  ${a.padEnd(38)} n=${v.n} nick=${v.sampleNick}`);

  const codes = [...new Set(svc14.map((p) => p.code))];
  console.log('\n-- 判定（2026-11-13 实测，非推测）--');
  console.log(`  14/* 回执码：${codes.join(',') || '（无）'}`);
  console.log('  SDK 9.21.18 源码已给出正确组包（14/3 subscribeEvent），按格式发包仍 403 + 空 body；');
  console.log('  同时 6/23、6/1、24/1 全 200；不存在的命令号(14/99、6/99)是「超时无回执」而非 403。');
  console.log('  ⇒ 服务端认识 14/* 但主动拒绝，且不是 body 格式问题；');
  console.log('    官方 SDK 9.x 完整登录包(2/3)也被回 403「非法操作或没有权限」。');
  console.log('  ⇒ 该 AppKey 未对粉丝号开放 14 事件服务（或客户端类型白名单），订阅路走不通。');
  console.log('  ⚠️ 本探针只作取证，别反复登录：短时间多次登录出现过 2/2 成功后连接被关。');
  console.log('=========================================\n');
}

async function send14(cmd, body, label) {
  try {
    const r = await client.nimSession.request(14, cmd, body, `14/${cmd} ${label}`);
    const buf = r.body || Buffer.alloc(0);
    let parsed = '';
    try {
      const a = decodeStrArray(buf);
      if (a) parsed = ` StrArray(${a.values.length})=[${a.values.slice(0, 6).join(',')}]`;
      const p = decodeProps(buf);
      if (p) parsed += ` Property(${p.map.size})=${JSON.stringify([...p.map.entries()]).slice(0, 300)}`;
      if (a && a.offset < buf.length) {
        const rest = buf.subarray(a.offset);
        const p2 = decodeProps(rest);
        if (p2) parsed += ` +后续Property=${JSON.stringify([...p2.map.entries()]).slice(0, 240)}`;
      }
    } catch { /* noop */ }
    console.log(`  14/${cmd} ${label.padEnd(28)} => code=${r.resultCode} len=${buf.length} hex=${buf.subarray(0, 24).toString('hex')}${parsed}`);
    return r;
  } catch (e) {
    console.log(`  14/${cmd} ${label.padEnd(28)} => ERR ${String(e.message || e).slice(0, 90)}`);
    return null;
  }
}

(async () => {
  cred = await credential();
  credLabel = `${cred.account.slice(0, 16)}… (${cred.from})`;
  log('凭据来源：' + credLabel);
  try {
    const r = await fetch(`https://lbs.netease.im/lbs/conf.jsp?k=${APP_KEY}&id=${encodeURIComponent(cred.account)}&v=91701&tp=1&dt=0`);
    const j = await r.json();
    log('LBS 地址：' + JSON.stringify(j?.common?.link || j).slice(0, 200));
  } catch (e) { log('LBS 读取失败：' + String(e.message || e).slice(0, 100)); }

  client = createNimCommonlinkQChatClient({
    appKey: APP_KEY,
    account: cred.account,
    token: cred.token,
    onRawPacket: observe,
    onMessage: (m) => {
      const a = String(m.fromAccount || '').trim();
      if (!a) return;
      const prev = fromAccounts.get(a) || { n: 0, sampleNick: '' };
      prev.n++;
      if (m.fromNick) prev.sampleNick = m.fromNick;
      fromAccounts.set(a, prev);
    },
    onError: (e) => log('onError:', String(e.message || e).slice(0, 120)),
    onDisconnected: (x) => log('连接断开:', JSON.stringify(x)),
  });

  log('连接云信…');
  await client.connect();
  log('NIM(2/2) + QChat(24/2) 均已登录');

  const ids = [...new Set(roomIds())].slice(0, ROOM_N);
  if (ids.length) {
    try {
      const r = await client.subscribe(ids);
      log(`已订阅 ${r.rooms.length} 个房间（失败 ${r.failedServers.length}）`);
    } catch (e) { log('房间订阅失败（不影响事件探针）：', String(e.message).slice(0, 100)); }
  }

  // 采几秒房间消息，拿到真实 accid 作订阅目标
  if (ROOM_N) {
    log('采集房间消息中的 fromAccount（3 秒）…');
    await new Promise((r) => setTimeout(r, 3000));
    log(`采到 ${fromAccounts.size} 个 accid`);
  }

  const second = envVal(resolve(HERE, 'nim-account2.env'), 'NIM2_ACCID');
  const targets = String(process.env.PROBE_ACCOUNTS || '')
    ? process.env.PROBE_ACCOUNTS.split(',').map((x) => x.trim()).filter(Boolean)
    : [cred.account, second, ...[...fromAccounts.keys()].slice(0, 4)].filter(Boolean);
  const accounts = [...new Set(targets)].slice(0, 8);
  console.log(`\n订阅目标(${accounts.length}): ${accounts.join(', ')}`);

  /* 对照：SDK 里 getServerTime = 6/23(params:[])、getSimpleNosToken = 6/1(Int num)。
     若这两个在 NIM 层也是 403 ⇒ 403 是「这条连接不受理业务请求」，与事件服务无关；
     若它们 200 ⇒ 14/* 的 403 是事件服务特有（功能未开通 / 权限）。 */
  console.log('\n-- NIM 层对照命令（判定 403 语义）--');
  const ctrls = [
    [6, 23, Buffer.alloc(0), 'getServerTime(空参)'],
    [6, 1, Buffer.from([1, 0, 0, 0]), 'getSimpleNosToken(Int 1)'],
    [24, 1, encodeProperties({ 1: 0 }), 'getQChatAddress(已知200)'],
  ];
  for (const [svc, cmd, b, label] of ctrls) {
    try {
      const r = await client.nimSession.request(svc, cmd, b, `ctrl ${svc}/${cmd}`);
      console.log(`  ${svc}/${cmd} ${label.padEnd(26)} => code=${r.resultCode} len=${r.body?.length || 0} hex=${(r.body || Buffer.alloc(0)).subarray(0, 16).toString('hex')}`);
    } catch (e) { console.log(`  ${svc}/${cmd} ${label.padEnd(26)} => ERR ${String(e.message || e).slice(0, 80)}`); }
  }

  console.log('\n-- 14/* 正确组包请求 --');
  const body = subscribeBody(accounts);
  log(`body ${body.length} bytes: ${body.subarray(0, 60).toString('hex')}`);
  await send14(3, body, 'subscribeEvent');
  await send14(6, body, 'queryByAccounts');
  await send14(7, encodeProperties({ 1: '1', 2: '2592000', 3: '1' }), 'queryByType');

  if (process.env.PROBE_RELOGIN === '1') {
    console.log('\n-- 补发 SDK 9.x 完整属性登录包(2/3)，再试 14/3 --');
    const loginProps = encodeProperties({
      3: 1,                 // clientType Android（口袋48 App 用）
      4: '12', 6: '92118', 8: 1, 9: 1,
      13: '7B93DFD0-472F-4736-A628-E85FAE086486',
      18: APP_KEY, 19: cred.account,
      24: 'Android 12', 26: 'probe-session', 32: 'SM-G9730',
      38: '', 40: '9.21.18', 41: 0, 42: 'PocketFans201807/7.1.45',
      112: 0, 115: 0, 1000: cred.token,
    });
    try {
      const r = await client.nimSession.request(2, 3, loginProps, 'relogin 2/3');
      console.log(`  2/3 完整登录 => code=${r.resultCode} len=${r.body?.length || 0} hex=${(r.body || Buffer.alloc(0)).subarray(0, 20).toString('hex')}`);
    } catch (e) { console.log(`  2/3 完整登录 => ERR ${String(e.message || e).slice(0, 90)}`); }
    await send14(3, body, 'relogin 后 subscribeEvent');
  }

  if (process.env.PROBE_FINAL === '1') {
    console.log('\n-- 最终定位：不存在的命令号 / 能力协商 / QChat 层 --');
    for (const [svc, cmd, b, label] of [
      [14, 99, Buffer.alloc(0), '14/99 不存在命令'],
      [6, 99, Buffer.alloc(0), '6/99 不存在命令'],
      [25, 99, Buffer.alloc(0), '25/99 不存在命令'],
    ]) {
      try {
        const r = await client.nimSession.request(svc, cmd, b, `final ${svc}/${cmd}`);
        console.log(`  ${label.padEnd(24)} => code=${r.resultCode} len=${r.body?.length || 0}`);
      } catch (e) { console.log(`  ${label.padEnd(24)} => ERR ${String(e.message || e).slice(0, 70)}`); }
    }
    // SDK 连接初始化会先做 1/5 协商、1/6 initTransport；补发后再试一次 14/3
    const int4 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; };
    for (const [cmd, b, label] of [
      [5, Buffer.concat([int4(92118), encodeProperties({ 1: '1', 2: '1' })]), '1/5 negotiateTransport'],
      [6, encodeProperties({ 1: '1', 2: '1' }), '1/6 initTransport'],
    ]) {
      try {
        const r = await client.nimSession.request(1, cmd, b, `final 1/${cmd}`);
        console.log(`  ${label.padEnd(24)} => code=${r.resultCode} len=${r.body?.length || 0}`);
      } catch (e) { console.log(`  ${label.padEnd(24)} => ERR ${String(e.message || e).slice(0, 70)}`); }
    }
    await send14(3, body, '协商后 subscribeEvent');
    try {
      const r = await client.qchatSession.request(14, 3, body, 'qchat 14/3');
      console.log(`  qchat层 14/3                => code=${r.resultCode} len=${r.body?.length || 0}`);
    } catch (e) { console.log(`  qchat层 14/3                => ERR ${String(e.message || e).slice(0, 70)}`); }
  }

  if (process.env.PROBE_VARIANTS === '1') {
    console.log('\n-- body 变体诊断 --');
    await send14(3, subscribeBody(accounts, { sync: 0 }), 'subscribeEvent sync=0');
    await send14(3, encodeProperties({ 1: '1', 2: '2592000', 3: '1' }), 'subscribeEvent 无accounts');
    await send14(3, strArrayBuf(accounts), 'subscribeEvent 仅accounts');
    await send14(1, encodeProperties({ 1: '1', 2: '1', 5: '3600', 6: '1', 7: '0' }), 'publishEvent 对照');
  }

  if (process.env.PROBE_SCAN === '1') {
    const svcs = [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 99];
    const rr = await Promise.all(svcs.map((s) =>
      client.nimSession.request(s, 1, Buffer.alloc(0), `scan ${s}/1`)
        .then((r) => ({ s, code: r.resultCode, len: r.body?.length || 0 }))
        .catch((e) => ({ s, err: String(e.message || e).slice(0, 60) }))
    ));
    console.log('\n-- 服务号对照扫描（svc/1 空包）--');
    for (const r of rr) console.log(`  ${String(r.s).padStart(3)}/1 => ${r.err || `code=${r.code} len=${r.len}`}`);
  }

  log(`保持连接观察 ${SECONDS} 秒（等 14/2、14/9 事件推送）…`);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  stop();
})().catch((e) => {
  log('探针失败：', String(e.stack || e).slice(0, 700));
  stop();
  process.exitCode = 1;
});
