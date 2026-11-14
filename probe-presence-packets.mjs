#!/usr/bin/env node
/**
 * 只读探针 · 把 NIM(IM 层) / QChat(成员房间) / Chatroom(直播聊天室) 三层包全听一遍
 * =====================================================================
 * 背景：qchat.cjs 原先只在 24/11 上解消息，其它包一律 return 丢掉；
 *       chatroom.cjs 只认 13/7、13/6、13/13。
 *       对方机器人能播报「XX 上线了」，要追平就得先看清服务端到底推了什么。
 *
 * 🔴 只读：不写站点、不写 KV、不改订阅关系、不发任何 14/* 主动请求（那是写操作）。
 *    仅做：登录长连接 + 订阅房间（既有行为）+ 查询一次聊天室在线人数（读）。
 * 🔴 脱敏：全包只交给 lib/raw-packet-log.mjs 做聚合，绝不打印 body / accid / uid / 昵称。
 * 🔴 账号：默认用第二账号（nim-account2.env），同一账号的两层**串行**跑，避免同号互踢；
 *    主账号留给它自己的线上采集进程。
 *
 * 用法：
 *   node probe-presence-packets.mjs                      # 三层全跑，各 90 秒
 *   node probe-presence-packets.mjs --sec=300           # 延长监听窗口
 *   node probe-presence-packets.mjs --layer=qchat       # 只听 NIM + QChat
 *   node probe-presence-packets.mjs --layer=chatroom    # 只听直播聊天室
 *   node probe-presence-packets.mjs --room=123456       # 指定聊天室 roomId
 *   node probe-presence-packets.mjs --srv=1,2,3         # 指定订阅的 serverId
 *   node probe-presence-packets.mjs --srv-all           # 用全量名册订阅（跳过 watch 名单，抓真实推送面）
 *   node probe-presence-packets.mjs --srv-count=200     # 名册取前 N 个
 *   node probe-presence-packets.mjs --decode=24/14      # 结构化解码指定包（只打印字段名/类型，绝不打印值）
 *   node probe-presence-packets.mjs --account=main      # 换用主账号（注意会踢线上主连接）
 *   node probe-presence-packets.mjs --no-sub            # 登录后不订阅，只看裸推送
 *
 * 落盘：.cache/raw-packets/presence-probe-YYYYMMDDHH.jsonl（聚合行，无原文）
 *
 * 2026-11-13 实测结论（主账号全量订阅 529 个 server → 订到 1999 个 channel）：
 *   · 旧结论「75 秒只见心跳」其实是**订阅失败**：watch 名单里 2 个 server 全是死房间、
 *     第二账号也没权限（rooms:0 / failedServers:2）。换主账号全量订阅后，
 *     90 秒窗口收到 82 条 24/11 消息 + 系统通知，推送链路本身完全正常。
 *   · 放开过滤后新看到 qchat 24/14（k=15 是 JSON：serverInfo{1..17} + type=10/13，
 *     服务器信息变更通知）与 24/26（两字段轻通知）；**都不是在线状态事件**，
 *     14/* 在线状态事件在整个窗口仍为 0。
 *   · chatroom(13/*) 层已接上，但当前没有在播直播（getLiveList 两种查询都 0 条），
 *     只验到握手 200 + 13/2 进入 404；等开播时直接 --layer=chatroom 复跑即可。
 *   · 口袋 API 在本沙箱：curl --noproxy '*' 直连 POST 稳定 200，node:https 直连 ECONNRESET、
 *     沙箱代理 TLS 会断 ⇒ apiPost() 一律 curl 优先、api.mjs 代理兜底。
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { get as httpsGet } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { postJson } from './lib/api.mjs';
import { generatePa } from './lib/pa.mjs';
import { API_BASE } from './lib/config.mjs';
import { createRawRecorder } from './lib/raw-packet-log.mjs';

const ROOT = import.meta.dirname;
const require = createRequire(import.meta.url);
const Q = require('./nim-client/qchat.cjs');
const C = require('./nim-client/chatroom.cjs');

const argv = process.argv.slice(2);
const opt = (name, def = '') => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? def : hit.slice(name.length + 3);
};
const SEC = Math.max(10, Number(opt('sec', 90)));
const LAYER = opt('layer', 'both');
const ROOM = opt('room', '');
const SRV_ARG = opt('srv', '');
const NO_SUB = argv.includes('--no-sub');
const SRV_ALL = argv.includes('--srv-all');
const SRV_COUNT = Math.max(1, Number(opt('srv-count', 120)));
const DECODE = new Set(opt('decode', '').split(',').map((s) => s.trim()).filter(Boolean));
const APP_KEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';

const envText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pick = (t, k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(t)?.[1] || '').trim().replace(/^["']|["']$/g, '');
const e2 = envText(resolve(ROOT, 'nim-client/nim-account2.env'));
let ACCID = pick(e2, 'NIM2_ACCID');
let TOKEN = pick(e2, 'NIM2_PW');
const POCKET = process.env.POCKET48_TOKEN || pick(envText(resolve(ROOT, 'nim-sync.env')), 'POCKET48_TOKEN');

const BJ = 8 * 3600e3;
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 口袋 API 直连通道：lib/api.mjs 默认走沙箱本地代理，实测代理 TLS 会断
   （「Client network socket disconnected before secure TLS connection」），
   导致主账号凭据 / 直播列表都拿不到。按项目既有铁律「出入口必须回退直连」，
   这里先直连，失败再走 api.mjs 的代理通道。 */
const APP_INFO = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
  osType: 'ios', deviceName: 'iPhone XR', os: 'ios'
});

const execFileAsync = promisify(execFile);

/* 实测结论（2026-11-13）：node:https 直连 POST 会被 ECONNRESET、沙箱代理 TLS 会断，
   但 curl --noproxy '*' 直连 POST 稳定 200（根路径 GET 403 属正常）。
   ⇒ 口袋 API 一律先走 curl 直连，失败才回退 lib/api.mjs 的代理通道。 */
async function pocketPostViaCurl(path, body) {
  const { stdout } = await execFileAsync('curl', [
    '-sS', '--noproxy', '*', '-m', '15', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8',
    '-H', 'appInfo: ' + APP_INFO,
    '-H', 'token: ' + POCKET,
    '-H', 'pa: ' + generatePa(),
    '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-H', 'Accept-Language: zh-Hans-CN;q=1',
    '-d', JSON.stringify(body || {})
  ], { timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(stdout);
}

async function apiPost(path, body) {
  try { return await pocketPostViaCurl(path, body); }
  catch (directError) {
    log(`curl 直连 ${path} 失败（${String(directError.message).slice(0, 60)}），回退代理通道`);
    return postJson(path, body, { token: POCKET, retries: 1 });
  }
}

/** 主账号凭据：与 client.mjs 的 nimCredentials() 同源，绝不打印值。 */
async function useMainAccount() {
  if (!POCKET) throw new Error('缺少 POCKET48_TOKEN，换不了主账号');
  const d = await apiPost('/im/api/v1/im/userinfo', {});
  const c = d?.content || {};
  ACCID = String(c.accid || c.accId || c.imUserId || '').trim();
  TOKEN = String(c.pwd || c.token || c.imPwd || '').trim();
  if (!ACCID || !TOKEN) throw new Error('云信凭据换取失败（接口没返回 accid/pwd）');
}

/* LBS 地址请求走 node:https 直连，绕开沙箱代理，避免 global fetch 被代理拦住。
   qchat.cjs / chatroom.cjs 只用 response.ok 与 response.json()，这个适配器够用。 */
function directFetch(url) {
  return new Promise((ok, fail) => {
    const req = httpsGet(String(url), { timeout: 15000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => ok({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: () => JSON.parse(body)
      }));
    });
    req.on('timeout', () => req.destroy(new Error('LBS 请求超时')));
    req.on('error', fail);
  });
}

/** 订阅哪些成员房间：优先 watch 名单，其次线上名册快照。只取数字 serverId。 */
function loadSrvs() {
  if (SRV_ARG) return SRV_ARG.split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  const members = resolve(ROOT, '../all48-worker/public/data/members.js');
  const sources = SRV_ALL ? [members] : ['/tmp/wxwatch.json', members];
  for (const p of sources) {
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, 'utf8');
      let arr;
      if (p.endsWith('.json')) {
        const j = JSON.parse(txt);
        arr = Array.isArray(j) ? j : (j.list || j.watches || []);
      } else {
        arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
      }
      const ids = [...new Set(arr.map((x) => String(x?.srv || x?.serverId || '')).filter((s) => /^\d+$/.test(s)))];
      if (ids.length) {
        const picked = ids.slice(0, SRV_ALL ? 600 : SRV_COUNT);
        log(`房间名册来源 ${p.split('/').pop()}：${ids.length} 个 serverId，本轮取 ${picked.length} 个`);
        return picked;
      }
    } catch (e) { log(`名册解析失败 ${p.split('/').pop()}：${String(e.message).slice(0, 60)}`); }
  }
  return [];
}

/** 找一个能进的聊天室：优先在播，退而求其次用最近结束的（可能已关）。 */
async function findRoom() {
  if (ROOM) return { roomId: ROOM, note: '手动指定' };
  if (!POCKET) return null;
  /* 🔴 roomId 可能是数字 0（直播没有聊天室），旧版用 String(0)='0' 判真，
     结果拿着 roomId=0 去进房，必然 404。这里强制转数字并要求 > 0。 */
  const attempts = [
    { label: '在播(groupId=12)', body: { debug: false, next: '0', groupId: 12, record: false } },
    { label: '在播(不带团)', body: { debug: true, next: '0', record: false } },
    { label: '最近结束（聊天室多半已关）', body: { debug: false, next: '0', groupId: 12, record: true } }
  ];
  for (const a of attempts) {
    try {
      const r = await apiPost('/live/api/v1/live/getLiveList', a.body);
      const list = r?.content?.liveList || [];
      log(`直播列表 ${a.label} → ${list.length} 条`);
      for (const x of list.slice(0, 6)) {
        try {
          const one = (await apiPost('/live/api/v1/live/getLiveOne',
            { liveId: String(x.liveId) }))?.content || {};
          const rid = Number(one.roomId || one.chatroomId || 0);
          if (rid > 0) return { roomId: String(rid), note: a.label };
        } catch { /* 换下一场 */ }
      }
    } catch (e) { log(`直播列表 ${a.label} 失败：${String(e.message).slice(0, 80)}`); }
  }
  return null;
}

const REC_LABEL = 'presence-probe-' + (opt('account', 'second') === 'main' ? 'main' : 'second');
const rec = createRawRecorder({
  label: REC_LABEL,
  dir: resolve(ROOT, '.cache/raw-packets'),
  flushMs: 30000
});
/* 解码结果也落盘（只有字段结构，无值）：终端输出可能被截断/审批挡住时仍可回溯。 */
const DECODE_FILE = resolve(ROOT, '.cache/raw-packets', `decode-${REC_LABEL}.jsonl`);

/* 结构化解码：只输出「字段编号 / 类型 / 长度 / JSON 顶层键」，绝不输出字段值，
   这样既能看懂 24/14 是不是在线状态事件，又不把 accid/uid/昵称带进日志。 */
/** JSON 只输出「字段名 + 嵌套字段名 + 小枚举值」，绝不输出字符串值 / 大数字（可能是 accid/uid）。 */
function jsonShape(text, depth = 0) {
  let j;
  try { j = JSON.parse(text); } catch { return 'invalid-json'; }
  if (Array.isArray(j)) {
    const head = j.length && j[0] && typeof j[0] === 'object'
      ? '{' + Object.keys(j[0]).slice(0, 18).join(',') + '}' : '';
    return `array(${j.length})${head}`;
  }
  if (!j || typeof j !== 'object') return 'scalar';
  const parts = [];
  for (const [k, v] of Object.entries(j)) {
    if (v && typeof v === 'object' && depth < 2) {
      const keys = Array.isArray(v) ? (v[0] && typeof v[0] === 'object' ? Object.keys(v[0]) : []) : Object.keys(v);
      parts.push(`${k}{${keys.slice(0, 18).join(',')}}`);
    } else if (typeof v === 'boolean') parts.push(`${k}=${v}`);
    else if (typeof v === 'number') parts.push(Math.abs(v) < 100000 ? `${k}=${v}` : `${k}:big`);
    else if (typeof v === 'string' && v.length <= 14 && /^[A-Za-z_]+$/.test(v)) parts.push(`${k}=${v}`);
    else parts.push(`${k}:${Array.isArray(v) ? 'array' : typeof v}(${String(v ?? '').length})`);
  }
  return parts.join(';').slice(0, 500);
}

let decoded = 0;
function describePacket(packet) {
  try {
    const props = Q.decodeProperties(packet.body);
    const fields = [];
    for (const [key, value] of props) {
      const text = String(value);
      let kind = 'str';
      let extra = '';
      if (/^\d+$/.test(text)) {
        kind = 'num';
        if (text.length <= 5) extra = `v=${text}`;       // 1~5 位一定是枚举，不是 uid
      } else if (/^[\[{]/.test(text.trim())) {
        kind = 'json';
        extra = jsonShape(text);
      }
      fields.push({ k: key, t: kind, n: text.length, ...(extra ? { s: extra } : {}) });
    }
    return fields;
  } catch (e) { return [{ error: String(e.message).slice(0, 80) }]; }
}

function maybeDecode(layer, packet) {
  if (!DECODE.size || decoded >= 20) return;
  const sc = `${packet.serviceId}/${packet.commandId}`;
  if (!DECODE.has(sc) && !DECODE.has(`${layer}:${sc}`)) return;
  decoded += 1;
  const line = JSON.stringify({ t: Date.now(), layer, sc, fields: describePacket(packet) });
  console.log(`  [DECODE ${layer} ${sc}] ${line}`);
  try { appendFileSync(DECODE_FILE, line + '\n'); } catch { /* ignore */ }
}

async function runQChat() {
  log('── [1/2] NIM(IM 层) + QChat(成员房间) 连接中…');
  const client = Q.createNimCommonlinkQChatClient({
    appKey: APP_KEY, account: ACCID, token: TOKEN,
    fetchImpl: directFetch,
    onRawPacket: (layer, packet, via) => { rec.note(layer, packet, via); maybeDecode(layer, packet); },
    onError: (e) => log('QChat 连接错误：' + String(e?.message || e).slice(0, 100))
  });
  try {
    await client.connect();
    log('✅ NIM + QChat 已登录（第二账号）');
  } catch (e) {
    log('✗ 登录失败：' + String(e?.message || e).slice(0, 140));
    try { client.destroy(); } catch { /* ignore */ }
    return;
  }

  const srvs = loadSrvs();
  if (!NO_SUB && srvs.length) {
    try {
      const sub = await client.subscribe(srvs);
      log(`✅ 订阅 ${srvs.length} 个 server → 订到 ${sub?.rooms?.length ?? 0} 个 channel，失败 server ${sub?.failedServers?.length ?? 0}`);
    } catch (e) { log('订阅异常：' + String(e?.message || e).slice(0, 120)); }
  } else {
    log(NO_SUB ? '--no-sub：登录后不订阅，只听裸推送' : '没有可用房间名册，只听裸推送');
  }

  log(`⏳ 监听 ${SEC} 秒…`);
  await sleep(SEC * 1000);
  try { client.destroy(); } catch { /* ignore */ }
  log('QChat 层已断开');
}

async function runChatroom() {
  log('── [2/2] Chatroom(直播聊天室) 层…');
  const found = await findRoom();
  if (!found) { log('✗ 没拿到 roomId（可用 --room= 指定），跳过 chatroom 层'); return; }
  log(`聊天室 ${found.note}，roomId=${found.roomId}`);

  const client = C.createNimCommonlinkChatroomClient({
    appKey: APP_KEY, account: ACCID, token: TOKEN, roomId: found.roomId,
    fetchImpl: directFetch,
    onRawPacket: (packet, via) => { rec.note('chatroom', packet, via); maybeDecode('chatroom', packet); },
    onError: (e) => log('Chatroom 连接错误：' + String(e?.message || e).slice(0, 100))
  });
  try {
    await client.connect();
    log('✅ 已进聊天室');
  } catch (e) {
    log('✗ 进入失败：' + String(e?.message || e).slice(0, 140));
    try { client.destroy(); } catch { /* ignore */ }
    return;
  }
  try {
    const info = await client.getChatroomInfo();
    log(`聊天室在线人数：${info.onlineMemberNum}`);
  } catch (e) { log('在线人数读取失败：' + String(e?.message || e).slice(0, 90)); }

  log(`⏳ 监听 ${SEC} 秒…`);
  await sleep(SEC * 1000);
  try { client.destroy(); } catch { /* ignore */ }
  log('Chatroom 层已断开');
}

function printSummary() {
  const rows = rec.summary();
  console.log('\n=== 全包包谱（聚合，脱敏）===');
  if (!rows.length) { console.log('（本次窗口没有收到任何包）'); return rows; }
  console.log('  层        类型      次数    resultCode  bodyLen        关键词');
  for (const r of rows) {
    const len = r.len[0] === r.len[1] ? String(r.len[0]) : `${r.len[0]}~${r.len[1]}`;
    console.log(`  ${r.candidate || ' '} ${r.layer.padEnd(9)} ${r.sc.padEnd(8)} ×${String(r.n).padEnd(6)} ${r.code.padEnd(11)} ${len.padEnd(15)} ${r.kw}${r.via.includes('embedded') ? ' [embedded]' : ''}`);
  }
  const cand = rows.filter((r) => r.candidate);
  const ev14 = rows.filter((r) => r.sc.startsWith('14/'));
  const qchatOther = rows.filter((r) => r.layer === 'qchat' && r.sc !== '24/11');
  console.log(`  合计 ${rows.length} 种包 / 非平凡 ${cand.length} 种 / 14/* 在线事件 ${ev14.length} 种 / QChat 非 24/11 ${qchatOther.length} 种`);
  return rows;
}

process.on('uncaughtException', (e) => log('[uncaught]', String(e?.message || e).slice(0, 120)));
process.on('unhandledRejection', (e) => log('[reject]', String(e?.message || e).slice(0, 120)));
process.on('SIGINT', () => { rec.close(); process.exit(0); });

(async () => {
  const ACCOUNT = opt('account', 'second');
  if (ACCOUNT === 'main') {
    try { await useMainAccount(); log('凭据：主账号（有房间订阅权限）'); }
    catch (e) { console.error('✗ ' + String(e?.message || e).slice(0, 160)); process.exit(1); }
  } else {
    if (!ACCID || !TOKEN) {
      console.error('✗ 缺少第二账号凭据 nim-client/nim-account2.env（NIM2_ACCID / NIM2_PW）');
      process.exit(1);
    }
    log('凭据：第二账号');
  }
  log(`只读探针启动 layer=${LAYER} sec=${SEC}（串行跑，避免同号互踢）`);
  if (LAYER === 'qchat' || LAYER === 'both') await runQChat();
  if (LAYER === 'both') await sleep(2000);   // 让上一层的单点会话彻底释放
  if (LAYER === 'chatroom' || LAYER === 'both') await runChatroom();

  const rows = printSummary();
  const ev14 = rows.filter((r) => r.sc.startsWith('14/'));
  const cand = rows.filter((r) => r.candidate);
  console.log('\n=== 判读 ===');
  if (ev14.length) console.log('  ⇒ 抓到 14/* 包：在线状态事件链路有推送，需按包格式解码');
  else console.log('  ⇒ 本窗口没有 14/* 推送（在线状态订阅未开通 / 窗口内无事件，两者不能只凭此区分）');
  if (cand.length) console.log('  ⇒ 有非平凡包，逐类看上面的 ★ 行与关键词，判断是否为进出/状态通知');
  else console.log('  ⇒ 除心跳、登录、订阅回执、消息外没有其它包：这条链路上看不到上线通知');
  console.log(`  ⇒ 窗口只有 ${SEC} 秒；成员不在此期间打开 App 就不会有事件，需长期挂机取证（client.mjs RAW_LOG=1）`);

  const out = rec.close();
  console.log(`\n证据落盘：${out.file || '(无)'}  ${out.bytes} bytes${out.stopped ? '（已达体积上限停写）' : ''}`);
  process.exit(0);
})();
