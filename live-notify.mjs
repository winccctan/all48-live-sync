#!/usr/bin/env node
/**
 * 直播开播 / 下播 → 微信推送（2026-11-11）
 * =========================================
 * 站长口径：「就是群里的一个微信号就行了，只要去推 …… 推王语晨的直播，
 *            什么时候开直播、什么时候结束直播就可以了」。
 *
 * 干什么：
 *   每 60 秒问一次口袋48 官方「直播中」列表（/live/api/v1/live/getLiveList），
 *   只盯 WATCH_UID 里的成员，状态翻转时推一条：
 *     · 不在播 → 在播   ⇒ 「开播了」+ 标题 + 类型 + 链接
 *     · 在播 → 连 3 次不在 ⇒ 「下播了」+ 播了多久
 *
 * 🔴 为什么要这个进程而不是 Worker cron：
 *    口袋48 按 IP 地域封锁，CF Worker（海外）直连一律 403；本机在日本反而通。
 *    另外 Worker 只读「热窗」，而热窗是 sync.yml 每 15 分钟才刷一轮 ⇒ 开播提醒最晚迟 15 分钟。
 *    这里直连官方接口，60 秒一轮，误差 ≤1 分钟。
 *
 * 🔴 上哪个「群」是另一件事（代码里已解耦）：
 *    · WECOM_HOOK   = 企业微信群机器人 webhook（官方、免费、零封号风险，但是「企业微信群」）
 *    · WX_PUSH_URL  = 任意本地/远程 HTTP 口，收 {"text": "..."}（个人微信号 bot 就挂这里）
 *    · 两个都不配    = 只打日志，不推送（默认，方便先验逻辑）
 *
 * 用法：
 *   node live-notify.mjs                 # 前台跑
 *   node live-notify.mjs --once          # 只跑一轮，打印当前状态（自检用）
 *   node live-notify.mjs --dry           # 不推，只打印会推什么
 *   node live-notify.mjs --test-start    # 造一条「开播」推送（验通道通不通）
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { generatePa } from './nim-client/pa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = HERE;

/* ---------------- 配置 ---------------- */
const envFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pickEnv = (txt, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const LIVE_ENV = envFile(resolve(ROOT, 'nim-sync.env'));
const PUSH_ENV = envFile(resolve(ROOT, 'live-notify.env'));   // 推送配置单独放，gitignore
const E = (k) => process.env[k] || pickEnv(PUSH_ENV, k) || pickEnv(LIVE_ENV, k) || '';

const TOKEN = E('POCKET48_TOKEN');
const WECOM_HOOK = E('WECOM_HOOK');
const WX_PUSH_URL = E('WX_PUSH_URL');

/* 安卓中转：本机起一个小小的取件口，手机上的 AutoJS6 脚本每 20 秒来取一次。
   🔴 为什么不直接 POST 给手机：手机没有公网地址，家里 Wi-Fi 的 IP 还会变。
      反过来让手机来「取」最省事 —— 手机在不在同一个 Wi-Fi 都能用（见下）。
   端口 8789，token 必填（等于密码，别人扫到就能让你群里说话）。 */
const WXQ_PORT = Number(E('WX_QUEUE_PORT') || 8789);
const WXQ_TOKEN = E('WX_QUEUE_TOKEN');
const WXQ_FILE = resolve(ROOT, 'nim-state/wxq.json');

/* 盯谁：默认王语晨（GNZ48 TEAM NIII，uid 89653517）。
   多个用逗号分隔，例如 WATCH_UID=89653517,89653427 */
const WATCH = String(E('WATCH_UID') || '89653517')
  .split(',').map((s) => s.trim()).filter(Boolean);
const POLL_MS = Math.max(20000, Number(E('POLL_MS') || 60000));
/* 🔴 链接必须用 wyc0518.cc，不能用 nim-sync.env 里的 SITE_URL（那是 workers.dev 测试域，
   国内基本打不开）。所以这里只认 live-notify.env / 环境变量，不吃 LIVE_ENV。 */
const SITE = (process.env.SITE_URL || pickEnv(PUSH_ENV, 'SITE_URL') || 'https://all48.wyc0518.cc').replace(/\/+$/, '');
const STATE_DIR = resolve(ROOT, 'nim-state');
const STATE_FILE = resolve(STATE_DIR, 'live-notify.json');

const ARG = new Set(process.argv.slice(2));
const ONCE = ARG.has('--once');
const DRY = ARG.has('--dry');
const TEST = ARG.has('--test-start');
/** 只开手机取件口、不轮询直播 —— 用来单独联调手机端（配 /say 手动入队） */
const QUEUE_ONLY = ARG.has('--queue');

if (!TOKEN) { console.error('[FATAL] 缺少 POCKET48_TOKEN（nim-sync.env）'); process.exit(1); }

const BJ = 8 * 3600e3;
const hhmm = (ms) => new Date(Number(ms) + BJ).toISOString().slice(11, 16);
const mdhm = (ms) => new Date(Number(ms) + BJ).toISOString().slice(5, 16).replace('T', ' ');
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(5, 19).replace('T', ' '), ...a);

/* ---------------- 口袋48 直播列表 ---------------- */
const appInfo = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
  osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});

async function fetchLiveList() {
  const r = await fetch('https://pocketapi.48.cn/live/api/v1/live/getLiveList', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=utf-8', appInfo,
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      'Accept-Language': 'zh-Hans-CN;q=1', token: TOKEN, pa: generatePa(),
    },
    body: JSON.stringify({ debug: false, next: '0', groupId: 12, record: false }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  const list = j && j.content && Array.isArray(j.content.liveList) ? j.content.liveList : [];
  return list.map((x) => {
    const ui = x.userInfo || {};
    return {
      liveId: String(x.liveId || ''),
      uid: String(ui.userId || ''),
      name: String(ui.starName || ui.realNickName || ui.nickname || '').replace(/^[A-Z]+48-/, ''),
      title: String(x.title || ''),
      ctime: Number(x.ctime) || 0,
      liveType: Number(x.liveType) || 0,   // 1 视频 / 2 电台
      cover: x.coverPath ? 'https://source.48.cn' + x.coverPath : '',
    };
  }).filter((x) => x.uid && x.liveId);
}

/* ---------------- 状态 ---------------- */
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
  } catch (e) { log('状态落盘失败：' + String(e.message).slice(0, 60)); }
}

/* ---------------- 安卓取件队列 ----------------
 * 手机上的 AutoJS6 脚本每 20 秒 GET /q?k=TOKEN，拿到就清空（取走即删，最多一次）。
 * 宁可偶发漏一条，也不要重复发 —— 群里刷两遍比少一条更难解释。
 */
function qLoad() {
  try {
    const a = JSON.parse(readFileSync(WXQ_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch { return []; }
}
function qSave(a) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(WXQ_FILE, JSON.stringify(a.slice(-40)));
  } catch (e) { log('队列落盘失败：' + String(e.message).slice(0, 60)); }
}
function qPush(text) {
  const a = qLoad();
  a.push({ t: Date.now(), text });
  qSave(a);
  log(`已入队，等手机取走（队列 ${a.length} 条）`);
}

function lanAddrs() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const x of list || []) if (x.family === 'IPv4' && !x.internal) out.push(`${name}:${x.address}`);
    }
  } catch { }
  return out;
}

let lastPhoneState = '';          // 手机上一次报上来的状态，变了才打日志
function startQueue() {
  if (!WXQ_TOKEN) {
    log('[队列] 未配 WX_QUEUE_TOKEN ⇒ 手机取件口不启动（推送会只打日志）');
    return;
  }
  const srv = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (u.searchParams.get('k') !== WXQ_TOKEN) return send(403, { ok: 0, e: 'token' });

    if (u.pathname === '/q' && req.method === 'GET') {
      /* 手机每轮取件时会带 &s=上一轮的结果（sent / launch-fail / room-fail / …），
         状态变化才打日志 —— 这样在 Mac 上就能看到手机走到哪一步，不用来回截图 */
      const st = (u.searchParams.get('s') || '').slice(0, 200);
      if (st && st !== lastPhoneState) {
        lastPhoneState = st;
        log('[手机] ' + st);
        /* 落一条到 nim-state/phone.log —— 站长不在旁边时也能回看手机走到哪一步 */
        try {
          appendFileSync(new URL('./nim-state/phone.log', import.meta.url),
            new Date().toISOString() + '  ' + st + '\n');
        } catch { }
      }
      const a = qLoad();
      if (u.searchParams.get('keep') === '1') return send(200, { ok: 1, items: a });
      if (a.length) {
        qSave([]);
        log(`手机取走 ${a.length} 条`);
      }
      return send(200, { ok: 1, items: a.map((x) => ({ t: x.t, text: x.text })) });
    }

    if (u.pathname === '/say' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
      req.on('end', () => {
        let text = '';
        try { text = String(JSON.parse(body).text || ''); } catch { text = ''; }
        if (!text) return send(400, { ok: 0, e: 'text' });
        qPush(text.slice(0, 1200));
        send(200, { ok: 1, q: qLoad().length });
      });
      return;
    }

    /* 手机把截图 POST 上来，存到 nim-state/shots/ —— 安卓微信读不到节点，
       只能靠"看"屏幕来定位坐标，所以这个口是后续一切操作的眼睛 */
    if (u.pathname === '/shot' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 16 * 1024 * 1024) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(body);
          const tag = (String(j.tag || 'shot').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)) || 'shot';
          const b64 = String(j.b64 || '').replace(/^data:image\/\w+;base64,/, '');
          const dir = new URL('./nim-state/shots/', import.meta.url);
          mkdirSync(dir, { recursive: true });
          const f = new URL(tag + '-' + Date.now() + '.jpg', dir);
          writeFileSync(f, Buffer.from(b64, 'base64'));
          log('[截图] ' + tag + ' ' + Math.round(b64.length / 1024) + 'KB');
          send(200, { ok: 1 });
        } catch (e) { send(500, { ok: 0, e: String(e).slice(0, 80) }); }
      });
      return;
    }

    if (u.pathname === '/ping') return send(200, { ok: 1, q: qLoad().length, up: process.uptime() | 0 });
    return send(404, { ok: 0 });
  });
  srv.on('error', (e) => log('[队列] 启动失败：' + String(e.message).slice(0, 80)));
  srv.listen(WXQ_PORT, '0.0.0.0', () => {
    log(`[队列] 取件口已开，端口 ${WXQ_PORT}，手机填：http://${(lanAddrs()[0] || '127.0.0.1:?').split(':').pop()}:${WXQ_PORT}`);
    log('[队列] 网卡：' + (lanAddrs().join('  ') || '无局域网 IP'));
  });
  return srv;
}

/* ---------------- 推送 ---------------- */
async function push({ md, text }) {
  if (DRY) { log('[DRY] 会推：\n' + text); return; }
  let ok = 0;
  if (WECOM_HOOK) {
    try {
      const r = await fetch(WECOM_HOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content: md.slice(0, 4000) } }),
        signal: AbortSignal.timeout(15000),
      });
      const j = await r.json().catch(() => ({}));
      if (j.errcode) log('企微推送失败 ' + j.errcode + ' ' + (j.errmsg || ''));
      else ok++;
    } catch (e) { log('企微推送异常：' + String(e.message).slice(0, 60)); }
  }
  if (WX_PUSH_URL) {
    try {
      const r = await fetch(WX_PUSH_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, md }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) log('微信通道 HTTP ' + r.status);
      else ok++;
    } catch (e) { log('微信通道异常：' + String(e.message).slice(0, 60)); }
  }
  if (WXQ_TOKEN) { qPush(text); ok++; }
  if (!ok && !WECOM_HOOK && !WX_PUSH_URL) log('[无通道] ' + text.replace(/\n/g, ' / '));
}

/* 站点直播大厅：VIEWS = ['members','live','follow','tools']，?v=live 直达 */
const LIVE_URL = () => SITE + '/?v=live';

function startMsg(x, now) {
  const kind = x.liveType === 2 ? '电台' : '直播';
  const text = [
    `【开播】${x.name} 的${kind}开始了`,
    x.title ? `标题：${x.title}` : '',
    `开播：${hhmm(x.ctime || now)}`,
    `入口：${LIVE_URL()}`,
  ].filter(Boolean).join('\n');
  const md = [
    `### 🎬 ${x.name} 开播了`,
    x.title ? `> 标题：**${x.title}**` : `> ${kind}进行中`,
    `> 开播时间：<font color="info">${hhmm(x.ctime || now)}</font>`,
    `[▶ 点这里看直播大厅]( ${LIVE_URL()} )`,
  ].join('\n');
  return { text, md };
}

function endMsg(x, endAt) {
  const mins = Math.max(1, Math.round((endAt - (x.ctime || endAt)) / 60000));
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分` : `${mins} 分钟`;
  const text = [
    `【下播】${x.name} 结束了`,
    x.title ? `标题：${x.title}` : '',
    `${hhmm(x.ctime)} – ${hhmm(endAt)}，共 ${dur}`,
  ].filter(Boolean).join('\n');
  const md = [
    `### ⚪ ${x.name} 下播了`,
    x.title ? `> 标题：${x.title}` : '',
    `> ${hhmm(x.ctime)} – ${hhmm(endAt)}，共 **${dur}**`,
  ].filter(Boolean).join('\n');
  return { text, md };
}

/* ---------------- 主循环 ---------------- */
let fails = 0;

async function tick() {
  let list;
  try {
    list = await fetchLiveList();
    fails = 0;
  } catch (e) {
    fails++;
    log(`拉列表失败（第 ${fails} 次）：` + String(e.message).slice(0, 80));
    return;
  }
  const st = loadState();
  const now = Date.now();
  let dirty = false;

  for (const uid of WATCH) {
    const cur = list.find((x) => x.uid === uid);
    const prev = st[uid] || null;

    if (cur && (!prev || prev.liveId !== cur.liveId)) {
      // 新开播（或换了场次）。进程刚起就在播时不推，避免重启刷屏 —— 除非 NOTIFY_ON_BOOT=1
      const booting = !prev;
      if (!booting || E('NOTIFY_ON_BOOT') === '1') {
        log(`开播 → ${cur.name} ${cur.liveId} 「${cur.title}」`);
        await push(startMsg(cur, now));
      } else {
        log(`（启动时已在播，不推送）${cur.name} ${cur.liveId} 「${cur.title}」`);
      }
      st[uid] = { liveId: cur.liveId, name: cur.name, title: cur.title, ctime: cur.ctime, miss: 0 };
      dirty = true;
      continue;
    }

    if (cur && prev) {
      if (prev.miss) { prev.miss = 0; dirty = true; }
      if (prev.title !== cur.title && cur.title) { prev.title = cur.title; dirty = true; }
      continue;
    }

    if (!cur && prev && prev.liveId) {
      // 连续 3 次不在列表才认定下播：列表偶发少一条不该推「下播」
      prev.miss = (prev.miss || 0) + 1;
      dirty = true;
      if (prev.miss >= 3) {
        log(`下播 → ${prev.name} ${prev.liveId}`);
        await push(endMsg(prev, now));
        st[uid] = { liveId: '', name: prev.name, title: '', ctime: 0, miss: 0 };
      }
    }
  }
  if (dirty) saveState(st);
  if (ONCE) {
    const me = list.filter((x) => WATCH.includes(x.uid));
    log(`当前在播（${WATCH.join(',')} 里命中 ${me.length} 场）：` + (me.map((x) => `${x.name}「${x.title}」`).join('，') || '无'));
    log('全部在播 ' + list.length + ' 场：' + list.slice(0, 20).map((x) => x.name).join('、'));
  }
}

if (QUEUE_ONLY) {
  startQueue();
  log('[队列] 仅取件模式（不轮询直播）。手动入队测试：');
  log('  curl -X POST "http://127.0.0.1:' + WXQ_PORT + '/say?k=口令" -d \'{"text":"测试一条"}\'');
  await new Promise(() => { });
} else if (TEST) {
  const fake = { liveId: '0', uid: WATCH[0], name: '王语晨', title: '【测试】通道自检', ctime: Date.now() - 300000, liveType: 1 };
  startQueue();                                  // 测试时也要开取件口，否则手机拿不到
  log('发一条测试推送…');
  await push(startMsg(fake, Date.now()));
  log('已排队，等手机来取（60 秒后自动退出；没收到就检查 WX_QUEUE_TOKEN / 手机连的 Wi-Fi）');
  setTimeout(() => process.exit(0), 60000);
  await new Promise(() => { });                  // 挂住，别让进程提前结束
} else {
  startQueue();
  await tick();
  if (!ONCE) {
    log(`开始盯 ${WATCH.join(',')}，每 ${Math.round(POLL_MS / 1000)} 秒一轮`);
    setInterval(() => { tick().catch((e) => log('tick 异常：' + String(e.message).slice(0, 80))); }, POLL_MS);
  } else {
    process.exit(0);
  }
}
