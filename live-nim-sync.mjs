/**
 * 红蓝歌会 · 直播侧礼物「实时」监听（网易云信 NIM Chatroom 常驻进程）
 *
 * 干什么：
 *   口袋48 的**直播间送礼不进房间 IM**（房间 IM 那条链路 gift-sync.mjs 只能覆盖房间），
 *   它走云信 NIM 聊天室的长连接推送。本脚本常驻在**国内出口的机器**上，
 *   把所有在播直播间的弹幕全部收下来，筛出「弦月回响」，实时 POST 到站点
 *   /api/gift/ingest（src=1）。相比 live-gift-sync.mjs（等播完扒 LRC 回放），
 *   这里能做到**秒级**。
 *
 * 🔴 为什么必须国内机器（2026-10-24 定论，别再试 GitHub Actions）：
 *   ① 口袋48 的 API 按 IP 地域拦，海外出口直连 403 ⇒ 要用 SCRAPE_PROXY 中转（那是 HTTP 代理，
 *      长连接 WebSocket 穿不过去，也没法穿）。
 *   ② 云信 NIM 登录能过（拿得到 accid/pwd），但**进房 WS 立刻 403**（Azure/海外出口）。
 *      唯一的稳定解法是直接跑在国内 IP 上，不绕代理。
 *
 * 🔴 多房间：一个直播间 = 一个 NIM 实例 = 一条 WS。脚本按在线人数排序取前
 *   NIM_ROOMS_MAX 个房间同时监听。云信对同一 accid 的多连接有互踢风险，
 *   所以每个房间独立记账：连续断线且一条消息都收不到的实例会被踢出轮转表（记日志），
 *   不会把整个进程拖死。healthz 里 `unstable` 字段能直接看出来。
 *
 * 常用环境变量（完整清单见 deploy/nim-sync.env.example）：
 *   SITE_URL          站点地址（必填）
 *   INGEST_TOKEN      上报令牌（必填，与 Worker secret 一致）
 *   POCKET48_TOKEN    口袋48 token（必填，过期就换）
 *   NIM_ROOMS_MAX     最多同时监听多少个直播间（默认 6）
 *   NIM_PORT          本地 healthz 端口（默认 8788，0 关掉；只听 127.0.0.1）
 *   NIM_DUMP=1        把没认出来的消息原文落盘（校准礼物消息结构时用）
 *   DRY=1             只打印不上报
 */
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
// 🔴 代理必须在 import lib/api.mjs **之前**清掉：
//    那个模块在加载时就把 SCRAPE_PROXY/HTTPS_PROXY 算成代理列表并打印，
//    而这台机器要求**国内直连**——一旦被环境里的海外代理劫走，口袋接口立刻 403。
//    确实需要代理时（比如临时调试）显式给 USE_PROXY=1。
if (!process.env.USE_PROXY) {
  for (const k of ['SCRAPE_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    if (process.env[k]) {
      console.log(`[代理] 忽略 ${k}=${String(process.env[k]).replace(/\/\/[^@/]*@/, '//***@')}（这台机器直连，见 deploy/README.md）`);
      delete process.env[k];
    }
  }
}
const { postJson } = await import('./lib/api.mjs');
import { createGiftParser } from './lib/nim-parse.mjs';

const require = createRequire(import.meta.url);

/* ---------------------------------------------------------------- 基础环境 */

// 🔴 NIM SDK 会写 navigator / window / XMLHttpRequest，Node 里必须先垫好，否则 SDK 初始化即崩
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

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const APPKEY = process.env.NIM_APPKEY || '632feff1f4c838541ab75195d1ceb3fa';
const ROOMS_MAX = Math.max(1, Number(process.env.NIM_ROOMS_MAX || 6));
const PORT = Number(process.env.NIM_PORT === undefined ? 8788 : process.env.NIM_PORT);
const BIND = process.env.NIM_BIND || '127.0.0.1';
const SCAN_MS = Math.max(20, Number(process.env.NIM_SCAN || 60)) * 1000;      // 在播重扫
const FLUSH_MS = Math.max(2, Number(process.env.NIM_FLUSH || 5)) * 1000;      // 上报节流
const DUMP = !!process.env.NIM_DUMP;
const DRY = !!process.env.DRY;
const STATE_DIR = process.env.NIM_STATE || path.resolve('nim-state');

// 🔴 顺序按「国内出口」排（2026-10-24 实测）：大陆机器 link-ga-hz 最快，
//    weblink01 稳；weblinkoutsea01 是海外节点，国内反而慢。
//    逐个探活，用第一个能建 WS 的。
const LINKS = String(process.env.NIM_LINKS || [
  'link-ga-hz.yunxinfw.com:443',
  'weblink01.netease.im:443',
  'chatweblink01.netease.im:443',
  'hkpxy0.netease.im:443',
  'weblinkoutsea01.netease.im:443',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const warn = (...a) => console.warn(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN（口袋48 登录 token）'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }
if (PORT) {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* noop */ }
}

/* -------------------------------------------------------------- 运行时状态 */

const startedAt = Date.now();
const stat = {
  scans: 0, scanErr: 0, tokenBad: false,
  msgs: 0, hits: 0, sent: 0, queued: 0, dropDup: 0,
  lastHitAt: 0, lastMsgAt: 0, lastFlushAt: 0, lastScanAt: 0,
  cfg: { name: '', ids: [] }, link: '',
};
const rooms = new Map();       // liveId -> Room
let target = { name: '', ids: new Set() };
let rosterByName = new Map();  // 昵称 -> uid（直播弹幕只有昵称，归户只能靠它）
let parser = null;             // ← lib/nim-parse.mjs 的实例，target/roster 变了要重建
let nimReady = false;
let accid = '';
let pwd = '';

/* ------------------------------------------------------------------ 工具 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeJson(x) {
  try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return ''; }
}

function bj(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0') + ' ' +
    String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' +
    String(d.getUTCSeconds()).padStart(2, '0');
}

/* 站点请求：超时 + 重试（国内机器直连，不需要代理） */
async function site(pathname, init, { timeout = 30000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(SITE + pathname, {
        ...init,
        signal: AbortSignal.timeout(timeout),
        headers: { Accept: 'application/json', ...(init && init.headers) },
      });
      if (!res.ok) throw new Error(`${pathname} → HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i === retries) break;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------- ① 成员目录（归户） */
// 直播弹幕只有「送给 SNH48-某某」，没有 uid，必须用成员目录反查。
async function loadRoster() {
  for (let i = 0; i < 5; i++) {
    try {
      const txt = await (await site('/data/members.js')).text();
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
      return true;
    } catch (e) {
      warn(`成员目录取不到（第 ${i + 1} 次）：${String(e.message).slice(0, 90)}`);
      await sleep(3000 * (i + 1));
    }
  }
  warn('⚠️ 成员目录最终失败 —— 直播礼物将无法归户（会照常上报，mid=0 会被站点丢掉），继续重试中');
  return false;
}

/* --------------------------------------------------- ② 站点下发目标礼物配置 */
async function loadCfg() {
  try {
    const j = await (await site('/api/gift/cursor', { headers: { 'x-ingest-token': INGEST } })).json();
    const cfg = (j && j.cfg) || {};
    const name = String(cfg.name || process.env.GIFT_NAME || '弦月回响').trim();
    const ids = new Set((Array.isArray(cfg.ids) ? cfg.ids : String(process.env.GIFT_IDS || '').split(',')).map(String).filter(Boolean));
    target = { name, ids };
    stat.cfg = { name, ids: [...ids] };
    parser = createGiftParser(target, rosterByName);
    log(`目标礼物「${name}」${ids.size ? ' + id 白名单 ' + [...ids].join(',') : ''}`);
  } catch (e) {
    if (!target.name) {
      const name = String(process.env.GIFT_NAME || '弦月回响').trim();
      target = { name, ids: new Set() };
      stat.cfg = { name, ids: [] };
      parser = createGiftParser(target, rosterByName);
    }
    warn('读站点礼物配置失败（沿用 ' + target.name + '）：' + String(e.message).slice(0, 90));
  }
}

/* ------------------------------------------------------- ③ 口袋48 直播接口 */
async function fetchLiveList() {
  const r = await postJson('/live/api/v1/live/getLiveList',
    { debug: true, next: '0', record: false }, { token: TOKEN, retries: 2 });
  const list = (r && r.content && r.content.liveList) || [];
  return list.map((x) => ({
    liveId: String(x.liveId || ''),
    uid: String((x.userInfo && x.userInfo.userId) || ''),
    nick: String((x.userInfo && x.userInfo.nickname) || ''),
    online: Number(x.onlineNum || 0),
    ctime: Number(x.ctime || 0),
    status: Number(x.status || 0),
  })).filter((x) => x.liveId);
}

async function fetchRoomId(liveId) {
  const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: String(liveId) }, { token: TOKEN, retries: 1 });
  const c = (d && d.content) || {};
  return { roomId: Number(c.roomId || 0), online: Number(c.onlineNum || 0), title: String(c.title || '') };
}

/** 探一个 WS 节点能不能建连（6 秒硬超时） */
function probeLink(hostPort) {
  const [host, port] = hostPort.split(':');
  return new Promise((resolve) => {
    let done = false, ws;
    const finish = (ok) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { ws && ws.close(); } catch { /* noop */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 6000);
    try {
      ws = new WebSocket(`wss://${host}:${port || 443}/websocket`);
      ws.onopen = () => finish(true);
      ws.onerror = () => finish(false);
    } catch { finish(false); }
  });
}

async function pickLink() {
  const results = [];
  for (const l of LINKS) {
    const ok = await probeLink(l);
    results.push(l + '=' + (ok ? 'OK' : '×'));
    if (ok) { stat.link = l; log('节点探测：' + results.join('  ') + ` ⇒ 用 ${l}`); return l; }
  }
  warn('节点全部不通：' + results.join('  '));
  return '';
}

/* ④ 解析礼物 → 见 lib/nim-parse.mjs（纯函数，可单测） */

/* ------------------------------------------------------------- ⑤ 上报队列 */

const queue = [];          // 待上报 items
const localSeen = new Set(); // 本地去重（同一条消息被 onmsg 与 on('message') 各触发一次）
const seqSeen = [];

function enqueue(item, key) {
  if (localSeen.has(key)) { stat.dropDup++; return; }
  localSeen.add(key);
  seqSeen.push(key);
  if (seqSeen.length > 4000) {
    const old = seqSeen.splice(0, 1000);
    for (const k of old) localSeen.delete(k);
  }
  queue.push(item);
  stat.hits++;
  stat.lastHitAt = Date.now();
  if (queue.length > 5000) queue.splice(0, queue.length - 5000);
}

const spoolFile = path.join(STATE_DIR, 'spool.jsonl');

function spoolLoad() {
  try {
    if (!fs.existsSync(spoolFile)) return;
    const lines = fs.readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean);
    for (const l of lines.slice(-2000)) {
      try { queue.push(JSON.parse(l)); } catch { /* noop */ }
    }
    if (queue.length) log(`恢复上次未上报的 ${queue.length} 条`);
  } catch { /* noop */ }
}

function spoolSave() {
  if (!queue.length) {
    try { if (fs.existsSync(spoolFile)) fs.unlinkSync(spoolFile); } catch { /* noop */ }
    return;
  }
  try {
    fs.writeFileSync(spoolFile, queue.slice(-2000).map((x) => JSON.stringify(x)).join('\n') + '\n');
  } catch { /* noop */ }
}

async function flush() {
  if (!queue.length || DRY) return;
  const batch = queue.slice(0, 1500);
  try {
    const res = await site('/api/gift/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify({ items: batch, stats: { [`[直播]${target.name}`]: batch.length } }),
    }, { timeout: 20000, retries: 1 });
    const out = await res.json().catch(() => ({}));
    queue.splice(0, batch.length);
    stat.sent += Number(out && out.added) || 0;
    stat.lastFlushAt = Date.now();
    log(`↑ 上报 ${batch.length} 条 → kept=${(out && out.kept) || 0} added=${(out && out.added) || 0} 队列剩 ${queue.length}`);
    if (queue.length) spoolSave(); else spoolSave();
  } catch (e) {
    warn(`上报失败（留在队列重试）：${String(e.message).slice(0, 120)}`);
    spoolSave();
  }
}

/* ----------------------------------------------------------------- ⑥ 房间 */

let NIMSDK = null;
function loadSdk() {
  if (NIMSDK) return NIMSDK;
  // 🔴 必须完整版 SDK：Chatroom 专用包在本帐号下登录直接 13_2（非法操作或没有权限）
  NIMSDK = require('@yxim/nim-web-sdk/dist/SDK/NIM_Web_SDK_nodejs.js');
  if (!NIMSDK || !NIMSDK.Chatroom) throw new Error('SDK 未导出 Chatroom');
  return NIMSDK;
}

class Room {
  constructor(info) {
    this.liveId = info.liveId;
    this.nick = info.nick;
    this.uid = info.uid;
    this.roomId = 0;
    this.title = '';
    this.state = 'init';        // init | entering | on | down | unstable
    this.msgs = 0;
    this.gifts = 0;
    this.reconnects = 0;
    this.connects = 0;
    this.lastMsgAt = 0;
    this.sinceMsgs = 0;
    this.enteredAt = 0;
    this.chatroom = null;
    this.timer = null;
    this.dumped = 0;
    this.samples = 0;
    this.deadAttempts = 0;
  }

  async enter() {
    if (!this.roomId) {
      try {
        const one = await fetchRoomId(this.liveId);
        this.roomId = one.roomId;
        this.title = one.title;
      } catch (e) {
        warn(`[${this.nick || this.liveId}] getLiveOne 失败：${String(e.message).slice(0, 80)}`);
        this.state = 'down';
        return;
      }
    }
    if (!this.roomId) { this.state = 'down'; return; }
    this.connect();
  }

  connect() {
    let sdk;
    try { sdk = loadSdk(); } catch (e) {
      warn('加载 NIM SDK 失败：' + String(e.message).slice(0, 160));
      this.state = 'down';
      return;
    }
    this.destroy(false);
    this.state = 'entering';
    this.enteredAt = Date.now();
    this.sinceMsgs = 0;
    const self = this;
    try {
      this.chatroom = sdk.Chatroom.getInstance({
        appKey: APPKEY,
        account: accid,
        token: pwd,
        chatroomId: this.roomId,
        chatroomAddresses: stat.link ? [stat.link] : undefined,
        db: false,
        // 🔴 onmsg 是 Chatroom 实例的正式回调名，on('message') 是兼容写法；两条都挂，靠 msgid 去重
        onmsg(msg) { self.handle(msg); },
        onconnect() {
          self.state = 'on';
          self.connects++;
          self.deadAttempts = 0;
          log(`✅ [${self.nick || self.liveId}] 进房成功 roomId=${self.roomId}`);
        },
        onwillreconnect() { log(`↻ [${self.nick || self.liveId}] 正在重连`); },
        ondisconnect(err) {
          const code = (err && (err.code || err.message)) || '';
          log(`⚠️ [${self.nick || self.liveId}] 断开 ${code}`);
          self.state = 'down';
          // 进房 90 秒内断开且一条消息都没收到 ⇒ 记一次「无消息断线」，连续 3 次就当这个房间进不去
          if (self.sinceMsgs === 0 && Date.now() - self.enteredAt < 90000) self.deadAttempts++;
          if (self.deadAttempts >= 3) {
            self.state = 'unstable';
            warn(`⛔ [${self.nick || self.liveId}] 连续 3 次进房即断且零消息 ⇒ 暂时放弃该房间（多半是同帐号多连接被踢）`);
            return;
          }
          self.scheduleRetry();
        },
        onerror(err) {
          warn(`[${self.nick || self.liveId}] NIM 错误 ${(err && (err.message || err.code)) || safeJson(err).slice(0, 80)}`);
        },
      });
      // 兼容写法（不同版本 SDK 事件名不一样，多挂不亏）
      try { this.chatroom.on?.('message', (msg) => self.handle(msg)); } catch { /* noop */ }
      stat.lastConnectAt = Date.now();
    } catch (e) {
      warn(`[${this.nick || this.liveId}] 进房异常：${String(e.message).slice(0, 120)}`);
      this.state = 'down';
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    if (this.timer) return;
    const wait = Math.min(30000, 3000 * (this.reconnects + 1));
    this.reconnects++;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state === 'unstable') return;
      log(`↻ [${this.nick || this.liveId}] ${wait}ms 后重建实例（第 ${this.reconnects} 次）`);
      this.connect();
    }, wait);
  }

  handle(msg) {
    if (!msg) return;
    stat.msgs++;
    this.msgs++;
    stat.lastMsgAt = Date.now();
    this.lastMsgAt = stat.lastMsgAt;

    // 去重键：优先 SDK 给的 msgid，没有再退化到「发送者+时间+正文」
    const id = msg.idClient || msg.msgid || msg.msgId || msg.idServer ||
      ((msg.from || '') + '|' + (msg.time || '') + '|' + (typeof msg.text === 'string' ? msg.text : safeJson(msg.content || '')));
    const key = this.liveId + '#' + id;

    // 采样：校准「弦月回响」在 NIM 里的确切结构时开 NIM_DUMP=1
    if (DUMP && this.dumped < 200) {
      const txt = (typeof msg.text === 'string' ? msg.text : safeJson(msg.content || msg.attach || ''));
      if (txt && (msg.type !== 'text' || /礼物|送给|个/.test(txt))) {
        this.dumped++;
        try {
          fs.mkdirSync(path.join(STATE_DIR, 'samples'), { recursive: true });
          fs.appendFileSync(path.join(STATE_DIR, 'samples', `${this.liveId}.jsonl`),
            JSON.stringify({ at: Date.now(), type: msg.type, from: msg.from, fromNick: msg.fromNick, text: txt.slice(0, 800), raw: safeJson(msg).slice(0, 2000) }) + '\n');
        } catch { /* noop */ }
      }
    }

    const g = parser ? parser.parse(msg, this) : null;
    if (!g) return;
    if (!g.mid) {
      this.samples++;
      if (this.samples <= 5) warn(`⚠️ 直播礼物归户失败：「${g._to || '?'}」不在成员目录里 · 原文 ${g._raw.slice(0, 120)}`);
      return;
    }
    this.gifts++;
    enqueue({
      t: g.t, mid: g.mid, sid: g.sid, sn: g.sn, gid: g.gid, g: g.g, num: g.num, src: 1,
    }, key);
    log(`🎁 [直播] ${this.nick} ← ${g.sn || '匿名'} ${g.num} 个「${g.g}」 送给 ${g._to || g.mid} (${bj(g.t)})`);
  }

  destroy(clearRoom) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.chatroom && this.chatroom.disconnect && this.chatroom.disconnect(); } catch { /* noop */ }
    this.chatroom = null;
    if (clearRoom) this.roomId = 0;
    if (this.state !== 'unstable') this.state = 'down';
  }

  info() {
    return {
      liveId: this.liveId, nick: this.nick, roomId: this.roomId, state: this.state,
      msgs: this.msgs, gifts: this.gifts, connects: this.connects, reconnects: this.reconnects,
      lastMsgAgo: this.lastMsgAt ? Math.round((Date.now() - this.lastMsgAt) / 1000) : -1,
    };
  }
}

/* ------------------------------------------------------- ⑦ 在播扫描 / 调度 */

async function scanOnce() {
  stat.scans++;
  stat.lastScanAt = Date.now();
  let list = [];
  try {
    list = await fetchLiveList();
    stat.tokenBad = false;
  } catch (e) {
    const msg = String(e.message || e);
    stat.scanErr++;
    if (/403|401/.test(msg)) {
      if (!stat.tokenBad) warn('🔴 口袋48 接口 401/403 —— token 可能过期，或这台机器的出口 IP 被拦（必须是国内出口）');
      stat.tokenBad = true;
    } else {
      warn('在播列表失败：' + msg.slice(0, 120));
    }
    return;
  }
  log(`在播 ${list.length} 场`);

  // 已经下播的：离房
  const liveSet = new Set(list.map((x) => x.liveId));
  for (const [liveId, room] of rooms) {
    if (!liveSet.has(liveId)) {
      log(`– [${room.nick || liveId}] 已下播，离房（本次收到 ${room.msgs} 条 / 礼物 ${room.gifts} 条）`);
      room.destroy(true);
      rooms.delete(liveId);
    }
  }

  // 新开播的：按在线人数排序，最多同时听 ROOMS_MAX 个
  const active = [...rooms.values()].filter((r) => r.state === 'on' || r.state === 'entering').length;
  const cands = list
    .filter((x) => !rooms.has(x.liveId))
    .sort((a, b) => b.online - a.online);
  let slots = ROOMS_MAX - active;
  for (const x of cands) {
    if (slots <= 0) break;
    const room = new Room(x);
    if (x.online) room._online = x.online;
    rooms.set(x.liveId, room);
    slots--;
    await room.enter();
    await sleep(400);   // 别在同一毫秒里连开十来个 WS，云信会限速
  }
  const listen = [...rooms.values()];
  const notListened = list.filter((x) => !rooms.has(x.liveId)).length;
  if (notListened > 0) {
    log(`（还有 ${notListened} 场在播没听：已达 NIM_ROOMS_MAX=${ROOMS_MAX}，可按需调大）`);
  }
  // 上一轮进房失败（state=down 且没有挂着重连定时器）的，这轮再给一次机会
  for (const room of rooms.values()) {
    if (room.state === 'down' && !room.timer) {
      log(`↻ [${room.nick || room.liveId}] 上一轮没进到房，重试一次`);
      room.connect();
    }
  }

  log('监听中：' + (listen.length
    ? listen.map((r) => `${r.nick || r.liveId}[${r.state}${r.roomId ? '/' + r.roomId : ''}]`).join(' · ')
    : '（无）'));
}

/* ------------------------------------------------------------------ ⑧ 健康检查 */

function snapshot() {
  const list = [...rooms.values()].map((r) => r.info());
  return {
    ok: !stat.tokenBad,
    up: Math.round((Date.now() - startedAt) / 1000),
    mode: 'nim-live',
    link: stat.link,
    target: stat.cfg,
    tokenBad: stat.tokenBad,
    stats: {
      scans: stat.scans, scanErr: stat.scanErr, msgs: stat.msgs, hits: stat.hits,
      sent: stat.sent, queued: queue.length, dup: stat.dropDup,
      lastMsgAgo: stat.lastMsgAt ? Math.round((Date.now() - stat.lastMsgAt) / 1000) : -1,
      lastHitAgo: stat.lastHitAt ? Math.round((Date.now() - stat.lastHitAt) / 1000) : -1,
      lastFlushAgo: stat.lastFlushAt ? Math.round((Date.now() - stat.lastFlushAt) / 1000) : -1,
      lastScanAgo: stat.lastScanAt ? Math.round((Date.now() - stat.lastScanAt) / 1000) : -1,
    },
    rooms: list,
    unstable: list.filter((r) => r.state === 'unstable').length,
    at: Date.now(),
  };
}

function serveHealth() {
  if (!PORT) return;
  const srv = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/healthz')) {
      const body = JSON.stringify(snapshot(), null, 1);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404); res.end('404');
  });
  srv.on('error', (e) => warn('healthz 端口起不来：' + String(e.message).slice(0, 80)));
  srv.listen(PORT, BIND, () => log(`healthz http://${BIND}:${PORT}/healthz`));
}

/* ------------------------------------------------------------------ ⑨ 启动 */

async function boot() {
  log('=== 红蓝歌会 · 直播礼物实时监听（NIM）启动 ===');
  spoolLoad();
  await loadCfg();
  await loadRoster();
  serveHealth();

  // NIM 凭证：一个口袋帐号一套（accid/pwd），过期要重取
  for (let i = 0; i < 6; i++) {
    try {
      const info = await postJson('/im/api/v1/im/userinfo', {}, { token: TOKEN });
      accid = String((info && info.content && info.content.accid) || '');
      pwd = String((info && info.content && info.content.pwd) || '');
      if (accid && pwd) { nimReady = true; break; }
      throw new Error('没返回 accid/pwd');
    } catch (e) {
      warn(`取 NIM 凭证失败（第 ${i + 1} 次）：${String(e.message).slice(0, 100)}`);
      await sleep(3000 * (i + 1));
    }
  }
  if (!nimReady) {
    warn('🔴 NIM 凭证最终失败 —— 只能收房间侧数据了。进程不退出，5 分钟后重试。');
    setTimeout(boot, 300000);
    return;
  }
  log(`NIM 凭证 accid=${accid} pwd长度=${pwd.length}`);

  stat.link = await pickLink();
  if (!stat.link) {
    warn('🔴 没有可用的云信节点 —— 这台机器的出口大概不在国内（或防火墙封了 443 WS）。');
    warn('   进程不退出，60 秒后重新探测；如果一直失败，说明这台机器不是国内出口。');
  }

  await scanOnce();

  setInterval(() => { if (nimReady) scanOnce().catch((e) => warn('scan 异常：' + String(e.message).slice(0, 100))); }, SCAN_MS);
  setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  // 配置 / 成员目录每小时刷一次（活动道具可能改名）
  setInterval(() => { loadCfg().catch(() => {}); }, 3600 * 1000);
  setInterval(() => { loadRoster().catch(() => {}); }, 6 * 3600 * 1000);

  // 看门狗：某个房间「显示 on 但 10 分钟一条消息都没有」也可能是假连，重建一次
  setInterval(() => {
    for (const room of rooms.values()) {
      if (room.state === 'on' && room.lastMsgAt && Date.now() - room.lastMsgAt > 10 * 60 * 1000) {
        log(`↻ [${room.nick || room.liveId}] 10 分钟无消息，重建实例`);
        room.connect();
      }
      if (room.state === 'on' && !room.lastMsgAt && Date.now() - room.enteredAt > 10 * 60 * 1000) {
        log(`↻ [${room.nick || room.liveId}] 进房 10 分钟零消息，重建实例`);
        room.connect();
      }
      // 全局节点失效自愈
      if (!stat.link) pickLink().then((l) => { if (l) { for (const r of rooms.values()) if (r.state !== 'on') r.connect(); } });
    }
  }, 120000);

  log(`启动完成：最多同时监听 ${ROOMS_MAX} 个直播间，在播每 ${SCAN_MS / 1000}s 重扫，上报每 ${FLUSH_MS / 1000}s 一次`);
}

let exiting = false;
async function shutdown(sig) {
  if (exiting) return;
  exiting = true;
  log(`收到 ${sig}，收尾：上报队列 ${queue.length} 条`);
  for (const r of rooms.values()) r.destroy(true);
  try { await flush(); } catch { /* noop */ }
  spoolSave();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => warn('uncaughtException：' + ((e && e.stack) || e).toString().slice(0, 400)));
process.on('unhandledRejection', (e) => warn('unhandledRejection：' + String((e && e.message) || e).slice(0, 400)));

boot().catch((e) => { console.error('启动失败：' + ((e && e.stack) || e)); process.exit(1); });
