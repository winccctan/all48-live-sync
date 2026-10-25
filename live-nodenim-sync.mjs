/**
 * 红蓝歌会 · 直播间礼物实时监听（node-nim 版）
 * =====================================================================
 * 为什么换掉 live-nim-sync.mjs 的 web SDK：
 *   口袋48 的直播间=云信聊天室。web SDK 里 `Chatroom.getInstance({account,token})`
 *   一步到位，实测一律 `403 / 13_2 login error: 非法操作或没有权限`。
 *   qqtools（duan602728596/qqtools）用的是 node-nim（云信 C++ SDK 的 Node 绑定），
 *   入房必须走四步（见 packages/main/src/ipcHandle/nodeNimHandleLogin.mts）：
 *     ① nim.client.init(appKey, appDataDir)        —— appKey 明文 = 632feff1f4c838541ab75195d1ceb3fa
 *     ② nim.client.login(appKey, account, token)   —— account/token 取自 /im/api/v1/im/userinfo
 *     ③ nim.plugin.chatRoomRequestEnterAsync(roomId) —— 拿入房票据
 *     ④ chatroom.enter(roomId, 票据)               —— 才真正进房
 *
 * 🔴 硬前提：**必须国内出口**。本机（日本）/日本代理实测全部 403；
 *   云信对海外出口的登录直接 Forbidden，跟账号、token、appKey 都无关。
 *
 * 用法：
 *   node live-nodenim-sync.mjs                 # 常驻
 *   DRY=1 node live-nodenim-sync.mjs           # 只打日志不上报
 *   ROOMS=8 node live-nodenim-sync.mjs         # 最多同时听几个直播间
 *   SCAN=60 node live-nodenim-sync.mjs         # 在播重扫间隔（秒）
 *
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN / POCKET48_TOKEN   站点与口袋48凭证（必填）
 *   NODE_NIM_PATH   node-nim 模块路径（默认 ~/.workbuddy/binaries/node-nim/node-nim）
 *   NIM_APP_DATA    云信 SDK 数据目录（默认 ./nim-state/node-nim-data）
 *   NIM_PORT        healthz 端口（默认 8789；设 0 关掉）
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { postJson } from './lib/api.mjs';
import { createGiftParser } from './lib/nim-parse.mjs';

const require = createRequire(import.meta.url);
const NODE_NIM_PATH = process.env.NODE_NIM_PATH
  || path.join(process.env.HOME || '', '.workbuddy/binaries/node-nim/node-nim');

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const APP_DATA = process.env.NIM_APP_DATA || path.resolve('nim-state/node-nim-data');
const SCAN_MS = Math.max(20, Number(process.env.SCAN || 60)) * 1000;
const FLUSH_MS = Math.max(2, Number(process.env.FLUSH || 5)) * 1000;
const ROOMS_MAX = Math.max(1, Number(process.env.ROOMS || 40));
const PORT = Number(process.env.NIM_PORT === undefined ? 8789 : process.env.NIM_PORT);
const DRY = !!process.env.DRY;

const BJ = 8 * 3600e3;
const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const warn = (...a) => console.warn(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const bj = (ms) => new Date(Number(ms) + BJ).toISOString().slice(5, 19);

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }

let nodeNim;
try {
  nodeNim = require(NODE_NIM_PATH);
} catch (e) {
  console.error(`加载 node-nim 失败（路径 ${NODE_NIM_PATH}）：${e.message}`);
  process.exit(1);
}

/* ------------------------------------------------------------- 运行时状态 */
const stat = {
  startedAt: Date.now(), scans: 0, scanErr: 0,
  msgs: 0, gifts: 0, sent: 0, queued: 0, dup: 0,
  loginOk: false, loginCode: 0, lastMsgAt: 0, lastScanAt: 0, lastFlushAt: 0,
  cfg: { name: '', ids: [] },
};
const rooms = new Map();      // liveId -> Room
const outbox = [];            // 待上报
const seen = new Set();       // 本地去重
let parser = null;
let target = { name: '弦月回响', ids: new Set() };

/* --------------------------------------------------------------- 站点读写 */
async function siteGet(p) {
  const r = await fetch(SITE + p, { headers: { Accept: 'application/json', 'x-ingest-token': INGEST } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function loadCfg() {
  try {
    const j = await siteGet('/api/gift/cursor');
    const c = (j && j.cfg) || {};
    target = {
      name: String(c.name || '弦月回响').trim(),
      ids: new Set((Array.isArray(c.ids) ? c.ids : []).map(String).filter(Boolean)),
    };
    stat.cfg = { name: target.name, ids: [...target.ids] };
    log(`目标礼物「${target.name}」 ids=${[...target.ids].join(',') || '（按名字匹配）'}`);
  } catch (e) {
    warn('读站点配置失败，用默认「弦月回响」：' + String(e.message).slice(0, 80));
  }
}

let rosterByName = new Map();
async function loadRoster() {
  for (let i = 0; i < 4; i++) {
    try {
      const txt = await (await fetch(SITE + '/data/members.js')).text();
      const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
      const map = new Map();
      for (const m of arr) {
        if (!m || !m.n) continue;
        const k = String(m.n).trim();
        if (!map.has(k)) map.set(k, Number(m.id));
      }
      rosterByName = map;
      parser = createGiftParser(target, rosterByName);
      log(`成员目录 ${arr.length} 人（可反查 ${map.size} 个昵称）`);
      return;
    } catch (e) {
      warn(`成员目录取不到（${i + 1}/4）：${String(e.message).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

/* ------------------------------------------------------------- 上报队列 */
function enqueue(item, key) {
  if (seen.has(key)) { stat.dup++; return; }
  seen.add(key);
  outbox.push(item);
  stat.queued = outbox.length;
}

async function flush() {
  if (!outbox.length || DRY) return;
  const items = outbox.splice(0, 500);
  stat.queued = outbox.length;
  try {
    const r = await fetch(SITE + '/api/gift/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify({ items, ch: 'nim' }),
    });
    const j = await r.json().catch(() => ({}));
    stat.sent += Number(j.added) || 0;
    stat.lastFlushAt = Date.now();
    log(`↑ 上报 ${items.length} 条 → kept=${j.kept} added=${j.added}`);
  } catch (e) {
    outbox.unshift(...items);           // 失败放回去，下一轮重试
    stat.queued = outbox.length;
    warn('上报失败：' + String(e.message).slice(0, 80));
  }
}

/* --------------------------------------------------- node-nim 消息字段归一 */
// node-nim 用 msgContent/msgAttachment/msgTime/msgFromNick/msgFromAccount，
// 而 lib/nim-parse.mjs 按 web SDK 的 content/attach/time/fromNick/from 写的，这里对齐一次。
function normalize(m) {
  if (!m || typeof m !== 'object') return m;
  return {
    ...m,
    content: m.content !== undefined ? m.content : m.msgContent,
    attach: m.attach !== undefined ? m.attach : m.msgAttachment,
    time: m.time || m.msgTime,
    fromNick: m.fromNick || m.msgFromNick,
    from: m.from || m.msgFromAccount,
  };
}

/* ------------------------------------------------------------------ 房间 */
class Room {
  constructor(info) {
    this.liveId = String(info.liveId);
    this.nick = info.nick;
    this.roomId = 0;
    this.chatroom = null;
    this.state = 'init';     // init | entering | on | down | exited
    this.msgs = 0;
    this.gifts = 0;
    this.enteredAt = 0;
  }

  info() {
    return {
      liveId: this.liveId, nick: this.nick, roomId: this.roomId, state: this.state,
      msgs: this.msgs, gifts: this.gifts,
    };
  }

  async open() {
    try {
      const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: this.liveId }, { token: TOKEN, retries: 2 })).content || {};
      this.roomId = Number(one.roomId) || 0;
    } catch (e) {
      this.state = 'down';
      return;
    }
    if (!this.roomId) { this.state = 'down'; return; }   // 已结束/无聊天室

    let ticket = '';
    try {
      const [code, res] = await nodeNim.nim.plugin.chatRoomRequestEnterAsync(this.roomId, null, '');
      if (code !== nodeNim.NIMResCode.kNIMResSuccess) {
        warn(`[${this.nick}] 申请进房失败 code=${code}`);
        this.state = 'down';
        return;
      }
      ticket = res;
    } catch (e) {
      warn(`[${this.nick}] 申请进房异常：${String(e.message).slice(0, 80)}`);
      this.state = 'down';
      return;
    }

    this.state = 'entering';
    this.enteredAt = Date.now();
    const self = this;
    try {
      this.chatroom = new nodeNim.ChatRoom();
      this.chatroom.init('', '');
      this.chatroom.initEventHandlers();
      this.chatroom.on('enter', (rid, step, code, roomInfo, myInfo) => {
        if (step === 5 && code === 200) {
          self.state = 'on';
          log(`✅ [${self.nick}] 进房成功 roomId=${self.roomId}`);
        } else if (step >= 5 && code !== 200) {
          warn(`[${self.nick}] 进房失败 step=${step} code=${code}`);
          self.state = 'down';
        }
      });
      this.chatroom.on('receiveMsg', (n, msg) => self.handle(msg));
      this.chatroom.on('exit', (rid, code, reason) => {
        warn(`[${self.nick}] 退房 code=${code} reason=${reason}`);
        if (self.state !== 'exited') self.state = 'down';
      });
      this.chatroom.enter(this.roomId, ticket, {}, '');
    } catch (e) {
      warn(`[${this.nick}] 建实例异常：${String(e.message).slice(0, 80)}`);
      this.state = 'down';
    }
  }

  handle(raw) {
    stat.msgs++;
    this.msgs++;
    stat.lastMsgAt = Date.now();
    const m = normalize(raw);
    if (!parser) return;
    const g = parser.parse(m, { nick: this.nick });
    if (!g) return;
    if (!g.mid) {
      if (this.gifts === 0) warn(`⚠️ [${this.nick}] 礼物归户失败：「${g._to}」不在成员目录`);
      return;
    }
    this.gifts++;
    stat.gifts++;
    const key = `${g.t}|${g.sid}|${g.mid}|${g.gid}|${g.num}|1`;
    enqueue({ t: g.t, mid: g.mid, sid: g.sid, sn: g.sn, gid: g.gid, g: g.g, num: g.num, src: 1 }, key);
    log(`🎁 [${this.nick}] ← ${g.sn || '匿名'} ${g.num} 个「${g.g}」 送给 ${g._to} (${bj(g.t)})`);
  }

  close() {
    this.state = 'exited';
    try { this.chatroom && this.chatroom.exit(); } catch { /* noop */ }
    try { this.chatroom && this.chatroom.cleanup && this.chatroom.cleanup(); } catch { /* noop */ }
    this.chatroom = null;
  }
}

/* --------------------------------------------------------------- 在播扫描 */
async function scanOnce() {
  stat.scans++;
  stat.lastScanAt = Date.now();
  let list = [];
  try {
    const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
    list = ((r && r.content && r.content.liveList) || []).map((x) => ({
      liveId: String(x.liveId || ''),
      nick: String((x.userInfo && x.userInfo.nickname) || ''),
    })).filter((x) => x.liveId);
  } catch (e) {
    stat.scanErr++;
    warn('拉在播列表失败：' + String(e.message).slice(0, 80));
    return;
  }

  const liveIds = new Set(list.map((x) => x.liveId));
  // 已结束的关掉
  for (const [id, room] of rooms) {
    if (!liveIds.has(id) && room.state !== 'exited') {
      log(`📴 [${room.nick}] 下播，退房`);
      room.close();
      rooms.delete(id);
    }
  }
  // 新场次进房（受 ROOMS 限制）
  let added = 0;
  for (const s of list) {
    if (rooms.size >= ROOMS_MAX) break;
    if (rooms.has(s.liveId)) continue;
    const room = new Room(s);
    rooms.set(s.liveId, room);
    added++;
    room.open().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));   // 别瞬间打一堆进房请求
  }
  if (added) log(`在播 ${list.length} 场，新进房 ${added}，当前监听 ${rooms.size} 场`);
  else if (!rooms.size) log(`在播 ${list.length} 场，暂无可听场次`);
}

/* ---------------------------------------------------------------- healthz */
function serveHealth() {
  if (!PORT) return;
  http.createServer((req, res) => {
    const body = {
      up: 1,
      login: { ok: stat.loginOk, code: stat.loginCode },
      cfg: stat.cfg,
      scans: stat.scans, msgs: stat.msgs, gifts: stat.gifts, sent: stat.sent, queued: stat.queued,
      lastMsgAgo: stat.lastMsgAt ? Math.round((Date.now() - stat.lastMsgAt) / 1000) : -1,
      rooms: [...rooms.values()].map((r) => r.info()),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 1));
  }).listen(PORT, '127.0.0.1');
  log(`healthz → http://127.0.0.1:${PORT}/healthz`);
}

/* ------------------------------------------------------------------- 启动 */
async function boot() {
  log('=== 红蓝歌会 · 直播礼物监听（node-nim）启动 ===');
  await loadCfg();
  await loadRoster();

  fs.mkdirSync(APP_DATA, { recursive: true });
  const ok = nodeNim.nim.client.init(APPKEY, APP_DATA, '', {});
  log('client.init =', ok);
  if (!ok) { console.error('云信客户端初始化失败'); process.exit(1); }
  nodeNim.nim.initEventHandlers();

  const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN, retries: 3 });
  const c = (info && info.content) || {};
  const accid = String(c.accid || '');
  const pwd = String(c.pwd || '');
  log(`NIM 凭证 accid=${accid} pwd长度=${pwd.length}`);

  const loginRes = await nodeNim.nim.client.login(APPKEY, accid, pwd, null, '');
  const r = loginRes && loginRes[0];
  stat.loginCode = (r && r.res_code_) || -1;
  if (stat.loginCode !== nodeNim.NIMResCode.kNIMResSuccess) {
    stat.loginOk = false;
    warn(`🔴 NIM 登录失败 res_code_=${stat.loginCode}（403=Forbidden：出口 IP 不在国内 / 账号被限）`);
    warn('   进程不退出，60 秒后重试。国内机器上这里应该是 200。');
    setTimeout(boot, 60000);
    return;
  }
  stat.loginOk = true;
  log('✅ NIM 登录成功');

  serveHealth();
  await scanOnce();
  setInterval(() => scanOnce().catch(() => {}), SCAN_MS);
  setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  setInterval(() => { loadCfg().catch(() => {}); }, 3600 * 1000);
}

process.on('uncaughtException', (e) => warn('[uncaught]', String(e && e.message).slice(0, 160)));
process.on('unhandledRejection', (e) => warn('[reject]', String(e && e.message).slice(0, 160)));

await boot();
