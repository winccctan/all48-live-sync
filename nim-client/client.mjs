#!/usr/bin/env node
/**
 * all48 自建云信客户端（取代 48fan SSE 的礼物采集）
 * =====================================================================
 * 为什么要有它（2026-11-11 站长口径）：
 *   48fan 的 SSE 只转 `PRESENT_NORMAL` 的一部分，连刷/聚合事件（×99）整个不进流，
 *   红蓝比赛「他进队一秒比我们多 100 多分」就是这么来的；而且直播侧没有送礼人 uid。
 *   自建客户端直连网易云信（官方长连接），礼物事件是**原始推送**：
 *     giftInfo.giftNum = 连刷份数（×99 就是 99）、giftInfo.money = 单价、
 *     user.userId = 送礼人 uid、acceptUser.userId = 收礼成员。
 *
 * 连接形态：
 *   · QChat（成员房间）：一次连接，按 serverId 分批订阅全团房间（每批 ≤10）
 *   · Chatroom（直播）：每个在播直播一条连接，随 getLiveList 自动建/拆
 *
 * 上行：
 *   POST {SITE}/api/gift    { items:[{t,mid,sid,sn,g,gid,num,src}], ch:'nim' }
 *   POST {SITE}/api/lv/all  { items:[{t,mid,sid,sn,g,num,v,room,ch}], ch:'nim' }
 *   两边都用官方消息 uuid 做本地幂等，重复重连不会双计。
 *
 * 用法：
 *   node nim-client/client.mjs             # 正式跑
 *   DRY=1 node nim-client/client.mjs       # 只打印解析结果，不上报
 *   DEBUG=1 ...                            # 打印每条礼物
 * =====================================================================
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { openSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generatePa } from './pa.mjs';
import { priceOf } from '../lib/gift-price.mjs';
import { createRawRecorder } from '../lib/raw-packet-log.mjs';

const require = createRequire(import.meta.url);
const { NimCommonlinkQChatClient } = require('./qchat.cjs');
const { NimCommonlinkChatroomClient } = require('./chatroom.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/* ---------------- 配置 ---------------- */
const envFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pickEnv = (txt, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const LIVE_ENV = envFile(resolve(ROOT, 'nim-sync.env'));
const WRK_ENV = envFile(resolve(ROOT, '../all48-worker/.env'));

const TOKEN = process.env.POCKET48_TOKEN || pickEnv(LIVE_ENV, 'POCKET48_TOKEN');
const SITE = (process.env.SITE_URL || pickEnv(LIVE_ENV, 'SITE_URL') || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || pickEnv(LIVE_ENV, 'INGEST_TOKEN') || pickEnv(WRK_ENV, 'INGEST_TOKEN');
const APP_KEY = '632feff1f4c838541ab75195d1ceb3fa';

const DRY = !!process.env.DRY;
const DEBUG = !!process.env.DEBUG;
const WRITE_GIFT = process.env.NO_GIFT !== '1';
const WRITE_LV = process.env.NO_LV !== '1';
const WRITE_MSG = process.env.NO_MSG !== '1';
const MAX_LIVE = Math.max(1, Number(process.env.MAX_LIVE || 40));
const LIVE_POLL_MS = Math.max(5000, Number(process.env.LIVE_POLL_MS || 12000));
const REPORT_MS = Math.max(2000, Number(process.env.REPORT_MS || 5000));
const SUB_BATCH = Math.max(1, Number(process.env.SUB_BATCH || 10));

if (!TOKEN) { console.error('[FATAL] 缺少 POCKET48_TOKEN'); process.exit(1); }
if (!DRY && !INGEST) { console.error('[FATAL] 缺少 INGEST_TOKEN'); process.exit(1); }

const BJ = 8 * 3600e3;
const bjDay = (t) => new Date(t + BJ).toISOString().slice(0, 10).replace(/-/g, '');
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(5, 19).replace('T', ' '), ...a);

/* 🔴 可选「全包取证」：RAW_LOG=1 才开，默认完全不挂、零开销。
   90 秒探针抓不到上线事件，很可能只是窗口内没人上线；常驻进程长期挂着才能拿到证据。
   只记录包类型聚合（脱敏），落 .cache/raw-packets/nim-client-*.jsonl，不写站点、不写 KV。 */
const RAW_LOG = process.env.RAW_LOG === '1';
const rawRec = RAW_LOG ? createRawRecorder({
  label: 'nim-client',
  dir: resolve(ROOT, '.cache/raw-packets'),
  quiet: true,
  onCandidate: (x) => log(`[RAW] 非平凡包 ${x.layer} ${x.serviceId}/${x.commandId} len=${x.len}${x.kw.length ? ' kw=' + x.kw.join(',') : ''}`)
}) : null;
if (RAW_LOG) log('RAW_LOG=1：全包取证已开启（脱敏聚合，不写库）');

/* ---------------- 口袋 API（带 pa 签名） ---------------- */
const appInfo = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
  osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});
async function pocket(path, body) {
  const r = await fetch('https://pocketapi.48.cn' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=utf-8', appInfo,
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      'Accept-Language': 'zh-Hans-CN;q=1', token: TOKEN, pa: generatePa(),
    },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`pocket ${path} HTTP ${r.status}`);
  return r.json();
}

/* ---------------- 云信凭据 ---------------- */
async function nimCredentials() {
  if (process.env.NIM_ACCID && process.env.NIM_PW) {
    return { account: process.env.NIM_ACCID, token: process.env.NIM_PW };
  }
  const d = await pocket('/im/api/v1/im/userinfo', {});
  const c = d?.content || {};
  const account = String(c.accid || c.accId || c.imUserId || '').trim();
  const token = String(c.pwd || c.token || c.imPwd || '').trim();
  if (!account || !token) throw new Error('云信凭据换取失败');
  return { account, token };
}

/* ---------------- 名册（serverId/channelId → 成员） ---------------- */
const memberIds = new Set();     // 全部成员 uid，用来判断「这条发言是不是成员本人」
async function loadRoster() {
  let txt = '';
  try {
    const r = await fetch(SITE + '/data/members.js?v=' + Date.now());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    txt = await r.text();
  } catch (e) {
    log('名册线上取失败，读本地快照：' + String(e.message).slice(0, 60));
    txt = readFileSync(resolve(ROOT, '../all48-worker/public/data/members.js'), 'utf8');
  }
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  return arr.filter((m) => m && m.id && m.srv && String(m.tm || '').indexOf('荣誉') < 0);
}

/* ---------------- 上报队列 ---------------- */
const giftQ = [];
const lvQ = [];
/* 影子模式专用：giftQ 故意不带单价（/api/gift/ingest 不需要 v），
   但对账要看鸡腿，所以 DRY 时另存一份完整 item。 */
const dryQ = [];
const seen = new Set();          // uuid 幂等
const OUT = process.env.OUT || '';   // 逐条落盘（jsonl），用于和官方账本对账
let outFd = null;
if (OUT) outFd = openSync(OUT, 'a');
function pushItem(it) {
  if (!it) return;
  if (it.uid) {
    const k = it.uid;
    if (seen.has(k)) return;
    if (seen.size > 50000) seen.clear();
    seen.add(k);
  }
  if (outFd) writeSync(outFd, JSON.stringify(it) + '\n');
  if (DRY) dryQ.push(it);
  const t = it.t;
  giftQ.push({ t, mid: it.mid, sid: it.sid, sn: it.sn, g: it.g, gid: it.gid, num: it.num, src: it.src });
  if (it.v) lvQ.push({ t, mid: it.mid, sid: it.sid, sn: it.sn, g: it.g, num: it.num, v: it.v, room: it.src ? 2 : 1, ch: 'nim' });
}

async function post(path, body) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(SITE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      if (r.ok) return JSON.parse(txt);
      throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 120));
    } catch (e) {
      if (i === 3) throw e;
      await new Promise((res) => setTimeout(res, 700 * (i + 1)));
    }
  }
}

/* 影子模式落盘：DRY 不写库，但要留证据给对账器用（nim-shadow-own.mjs 读它）。
   一行一笔解析后的礼物，格式跟正式上报的 item 完全一致。 */
function dumpDry() {
  if (!dryQ.length) return;
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    const f = resolve(STATE_DIR, 'dry-' + bjDay(Date.now()) + '.jsonl');
    appendFileSync(f, dryQ.map((x) => JSON.stringify(x)).join('\n') + '\n');
    dryQ.length = 0;
  } catch (e) {
    log('dry 落盘失败：' + String(e.message).slice(0, 60));
  }
}

async function flush() {
  drainGiftBuf(true);                       // 上报前把缓冲里的合并结果吐出来，别卡在队列里
  if (DRY) { dumpDry(); giftQ.length = 0; lvQ.length = 0; return; }
  if (WRITE_GIFT && giftQ.length) {
    const batch = giftQ.splice(0, 800);
    try {
      const r = await post('/api/gift/ingest', { items: batch, ch: 'nim' });
      log(`gift +${r?.added ?? 0} (kept ${r?.kept ?? 0}, fuzzy ${r?.fuzzyDropped ?? 0})`);
    } catch (e) { giftQ.unshift(...batch); log('gift 上报失败：' + String(e.message).slice(0, 100)); }
  } else if (!WRITE_GIFT) giftQ.length = 0;

  if (WRITE_LV && lvQ.length) {
    const batch = lvQ.splice(0, 800);
    try {
      const r = await post('/api/lv/all', { items: batch, ch: 'nim' });
      log(`lv +${r?.added ?? 0}`);
    } catch (e) { lvQ.unshift(...batch); log('lv 上报失败：' + String(e.message).slice(0, 100)); }
  } else if (!WRITE_LV) lvQ.length = 0;

  await flushMsgs();
}

/* ---------------- 发言（口袋消息）采集 ----------------
 * 站长口径：成员的**所有**发言都要，不只是文字 —— 语音/视频/图片/翻牌回复/谢礼物/卡片，一样不能少。
 *
 * 云信侧的原始形态（2026-11-11 实测）：
 *   type 0   → 纯文本，正文在 `body`
 *   type 100 → 自定义消息，载荷在 `attachment`（JSON 字符串），里面有 `messageType`：
 *              FLIPCARD_AUDIO / FLIPCARD_VIDEO / AUDIO / VIDEO / IMAGE / GIFT_TEXT / SHARE_POSTS …
 *   `ext.user.userId` = 发这条消息的人（成员本人或串门成员/粉丝）。
 *
 * 归属规则：**只按「谁发的」归户**，不按「在谁的房间」归户。
 *   · 成员在自己房间发言 → 记到她自己名下
 *   · 成员去别人房间串门发言 → 还是记到她自己名下（这就是全站口径）
 *   · 粉丝发言 → 丢弃（补档站只存成员本人内容）
 * 这样 511 个房间一个连接就能把「全团所有成员的发言」一个人不漏地收齐。
 */
const msgQ = new Map();          // uid → view[]
const msgSeen = new Set();       // msgIdServer 幂等
let msgDropped = 0, msgUnknown = 0;

const LABEL = {
  LIVEPUSH: '开播提醒', OPEN_LIVE: '开播提醒', SHARE_POSTS: '分享',
  GIFT_TEXT: '礼物', AGENT_QCHAT_TEXT: 'AI 对话', AGENT_QCHAT_TEXT_REPLY: 'AI 对话',
  AGENT_QCHAT_GIFT_REPLY: 'AI 对话回复',
  FLIPCARD_AUDIO: '翻牌 · 语音', FLIPCARD_VIDEO: '翻牌 · 视频',
  AUDIO_GIFT_REPLY: '礼物语音回复', VIDEO: '视频', AUDIO: '语音', IMAGE: '图片',
};

function viewFromNim(d, ext) {
  const t = Number(d.time) || Date.now();
  let att = null;
  if (d.attachment) { try { att = JSON.parse(d.attachment); } catch { att = null; } }
  const k = String(att?.messageType || ext?.messageType || (String(d.body || '').trim() ? 'TEXT' : 'UNKNOWN'));
  const body = String(d.body || '');
  const s = (...v) => { for (const x of v) if (x && typeof x === 'string') return x; return ''; };

  // 媒体地址：口袋给相对路径，站点侧统一补域名
  const url = (p) => {
    if (!p) return '';
    if (/^(https?|data):/i.test(p)) return p;
    if (p.startsWith('//')) return 'https:' + p;
    const full = p.startsWith('/') ? p : '/' + p;
    return (/\.(aac|mp3|m4a|wav|mp4|mov|m4v|m3u8)(\?|$)/i.test(full) ? 'https://mp4.48.cn' : 'https://source3.48.cn') + full;
  };

  const o = { t, k, x: '', i: null, r: null, c: null, a: '', v: '' };
  if (k === 'TEXT') { o.x = body; return o; }
  if (!att) { o.x = body; o.k = body ? 'TEXT' : 'UNKNOWN'; if (!o.x) return null; return o; }

  const src = att.content && typeof att.content === 'object' ? att.content : att;

  switch (k) {
    case 'IMAGE': {
      const one = src.url || src.image || src.pic || src.path || '';
      const many = Array.isArray(src.imgs) ? src.imgs : Array.isArray(src.images) ? src.images : null;
      o.i = many ? many.map((x) => url(typeof x === 'string' ? x : x?.url)).filter(Boolean) : (one ? [url(one)] : null);
      o.x = body;
      break;
    }
    case 'AUDIO': case 'FLIPCARD_AUDIO': case 'AUDIO_GIFT_REPLY':
      o.a = url(s(src.url, src.audio, src.audioUrl, src.path));
      o.x = s(src.text, src.answer, src.content, body);
      break;
    case 'VIDEO': case 'FLIPCARD_VIDEO':
      o.v = url(s(src.url, src.video, src.videoUrl, src.path));
      o.x = s(src.text, src.answer, body);
      break;
    case 'GIFT_TEXT':
      o.x = s(src.text, src.giftName, body) || '礼物';
      o.c = ['礼物', s(src.giftName, src.text, '') || '礼物', url(s(src.giftPic, src.pic, ''))];
      break;
    case 'SHARE_POSTS':
      o.c = ['分享', s(src.title, src.postsTitle, src.text) || '分享', url(s(src.pic, src.cover, ''))];
      break;
    /* 2026-11-14 18:28 曾雪婷连发四条，微信里全是「[REPLY] 没有信息」（站长截图）。
       抓到的真实结构（两种，字段一致）：
         文字 · {"replyInfo":{"replyText":"粉丝原话","replyName":"粉丝昵称","text":"她回的这句"}}
         语音 · {"replyInfo":{"replyText":"粉丝原话","replyName":"粉丝昵称","voiceUrl":…,"duration":7}}
       🔴 `text` 是**她说的**，`replyText` 是**粉丝原话**（第一版取反了，会把粉丝的话当成她的回复）。
       以前这个类型不在表里 ⇒ 正文挖不到 ⇒ 推出去只剩一行类型标记。
       现在：她的话 + 一行引用（↳ @粉丝：原话）；语音版的转写由 wxQueue 补在最前面。 */
    case 'AUDIO_REPLY': case 'VIDEO_REPLY': case 'REPLY': case 'REPLY_TEXT': {
      const ri = (src.replyInfo && typeof src.replyInfo === 'object') ? src.replyInfo : src;
      const rn = s(ri.replyName, ri.nickName, ri.nick, '');      // 被翻牌的粉丝
      const quote = s(ri.replyText, ri.replyContent, '');        // 粉丝原话
      const mine = s(ri.text, ri.content, body, '');             // 她本人的文字（纯语音翻牌时为空）
      o.a = url(s(ri.voiceUrl, ri.audio, ri.audioUrl, ''));
      o.v = url(s(ri.videoUrl, ri.video, ''));
      o.x = [mine, quote ? `↳ @${rn || '粉丝'}：${quote}` : ''].filter(Boolean).join('\n');
      if (!o.x && !o.a && !o.v) return null;
      break;
    }
    default: {
      // 翻牌 / 卡片 / AI 对话 / 新图片类型 …：尽量把可读文本挖出来（body 也算，很多类型正文就放这儿）
      const x = s(src.answer, src.text, src.content, src.desc, src.title, src.question, body, '');
      o.a = url(s(src.audio, src.audioUrl, ''));
      o.v = url(s(src.video, src.videoUrl, ''));
      if (src.pic || src.cover || src.url) o.i = [url(s(src.pic, src.cover, src.url))];
      /* 🔴 2026-11-14 站长截图：房间发图片，微信里先来一行「[UNKNOWN]」再来图。
         根因：图片走的是没登记的消息类型，这里挖不到文本就无条件打类型标记，
         但紧接着图片又单独发了一条 ⇒ 用户看到两条，第一条还是乱码。
         现在：能取到图/语音/视频就**只发媒体**，一个字都不多打；
         真的什么内容都没有，才留类型标记（这类才算真未知，值得看一眼）。 */
      if (typeof x === 'string' && x) { o.x = x; }
      else if (o.i || o.a || o.v) { o.x = ''; if (k === 'UNKNOWN') o.k = o.i ? 'IMAGE' : (o.a ? 'AUDIO' : 'VIDEO'); }
      else {
        msgUnknown += 1; o.x = '[' + (LABEL[k] || k) + ']';
        /* 2026-11-14 18:28 曾雪婷那条 REPLY 推到微信是「[REPLY] 没有信息」：
           类型在表外、正文挖不出来。这里把原始 attachment 打一行，拿到结构就补 case。 */
        if (msgUnknown <= 40) log('[DUMP]', k, String(d.attachment || '').slice(0, 1000));
      }
      break;
    }
  }
  if (!o.x && !o.i && !o.a && !o.v) o.x = k === 'UNKNOWN' ? '' : '[' + (LABEL[k] || k) + ']';
  return o;
}

function pushMsg(d, p) {
  const u = p?.user || {};
  const uid = Number(u.userId) || 0;
  if (!uid) { msgDropped += 1; return; }
  if (!memberIds.has(uid)) { msgDropped += 1; return; }   // 粉丝发言不入库
  const key = String(d.msgIdServer || d.msgIdClient || '');
  if (!key) return;
  if (msgSeen.has(key)) return;
  if (msgSeen.size > 200000) msgSeen.clear();
  msgSeen.add(key);

  const v = viewFromNim(d, p?.merged || {});
  if (!v) return;            // 完全没内容的消息（解码不出任何东西）不入库、不推微信
  let arr = msgQ.get(uid);
  if (!arr) { arr = []; msgQ.set(uid, arr); }
  arr.push(v);
  if (DEBUG || DRY) log('[MSG]', uid, u.nickName || u.nickname || '', v.k, String(v.x || '').slice(0, 40));
  wxQueue(uid, v, d);        // ← 微信实时推送（长连接直推，不轮询）
}

/* ---------------- 微信实时推送（2026-11-14） ----------------
 * 站长：「为啥是抓取端？我们不是跟云信有推送吗，云信推了你就收得到，收到就推啊」。
 * 对 —— 这条长连接本来就实时的，只是以前收到只入库、不推微信，微信那条全靠 Actions
 * 每 5 分钟轮询，所以她连发几条会被攒成一条「N 条新消息」。
 * 现在她一发消息就在这里直接投队列，秒级、一条一条。
 *
 * 🔴 id 规则必须和 wx-actions.mjs 一模一样（`room:<uid>:<t>` / `roomimg:<uid>:<t>`）：
 *    Worker 的 /api/wxq/push 按 id 去重，两条通道同时开也只会发一条。
 *    ⇒ 常驻端挂了还有 Actions 兜底，不会因为「切到推送」就断消息。
 */
/* 🔴 2026-11-14 站长：「取关了怎么还会抓」。
   以前这里是**写死**的两个人（env `WX_ROOM_UIDS`），云端名单改了这里毫无反应 ——
   群里取关只是把云端名册删掉，这条快通道照旧按写死的名单抓、照旧往队列里投。
   现在改成**跟云端走**：启动拉一次 `/api/wxwatch`，之后每 5 分钟对一次；
   云端名册空了（全部群都取关）就退回 env，避免一次网络抖动把推送全停掉。 */
let WX_ROOM = new Map(
  String(process.env.WX_ROOM_UIDS || '89653517:王语晨,45285685:黄宣绮')
    .split(',').map((s) => s.split(':')).filter((a) => a.length === 2)
    .map(([u, n]) => [Number(u), n.trim()])
);
const WX_ROOM_ENV = new Map(WX_ROOM);

async function wxRoomLoad() {
  try {
    const r = await fetch(SITE + '/api/wxwatch', {
      headers: { 'x-ingest-token': INGEST }, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    const list = (j && Array.isArray(j.list)) ? j.list : [];
    const m = new Map();
    for (const it of list) {
      const uid = Number((it && it.uid) || 0);
      const nick = String((it && it.nick) || '').trim();
      if (uid && nick) m.set(uid, nick);
    }
    if (!m.size) { log('[WX] 云端名单是空的 ⇒ 退回 env 名单（' + [...WX_ROOM_ENV.values()].join('、') + '）'); WX_ROOM = new Map(WX_ROOM_ENV); return; }
    const before = [...WX_ROOM.keys()].sort().join(',');
    const after = [...m.keys()].sort().join(',');
    WX_ROOM = m;
    if (before !== after) log('[WX] 播报名单已更新：' + [...m.values()].join('、'));
  } catch (e) {
    log('[WX] 拉云端名单失败（沿用当前名单）：' + String((e && e.message) || e).slice(0, 60));
  }
}
const WX_PUSH_OFF = process.env.NO_WX_PUSH === '1' || DRY;
const wxBuf = [];
let wxFail = 0;

function wxClock(t) {
  const d = new Date(t + BJ);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/* ---------------- 实时在线雷达（2026-11-14 站长：「APP 上下线」） ----------------
 * 背景：口袋48 不公开成员登录态 ——
 *   · REST 侧：`friendships/friends` 的 userInfo、`seine/server/detail` 的 chatServerInfo
 *     全字段都翻过，没有任何 online / lastActiveTime / activeTime；
 *   · 云信侧：14 事件服务（publishEvent/subscribeEvent/query）对该 appKey 全 403 + 空 body，
 *     同一条连接上 2/2、6/23、24/1 全 200 ⇒ 是功能没对粉丝号开，不是组包问题；
 *   · AppSecret 拿不到（客户端里本就没有，APK 还是 360 加固）。
 *   ⇒ 「只是打开 App 一句话不说」这件事，任何第三方都拿不到（牙牙那个开源项目也没有）。
 *
 * 能做的：把「她的任何可观测动作」当成在线证据，并且**把观测面开满**：
 *   以前只认「她自己房间的消息」—— 但长连接其实订了全团房间，
 *   **她在别人房间发言、给别人送礼**同样收得到，以前白收了。
 *   这里把这些全部算成心跳，并将判定搬到长连接（秒级，Actions 那侧是 5 分钟一轮）。
 *
 * 与 Actions 共存（wx-actions.mjs）：
 *   · 上线 id 规则一致 `on:<首次动作t>`、下线 `off:<actT>`，桥按 id 去重；
 *   · 每次翻转都把 state 推到 `/api/wxq/push`（u=uid），Actions 下一轮读到 online=1
 *     就不会重复播报，也拿得到我们更新的 actT。
 *   · 容器挂了就只剩 Actions，行为退回改之前的样子，不会更差。
 */
const WX_ONLINE_MS = Math.max(60e3, Number(process.env.WX_ONLINE_MS || 5 * 60e3));
const WX_ON_COOLDOWN = Math.min(WX_ONLINE_MS, 5 * 60e3);
const wxPresence = new Map();     // uid -> {online, onT, at, kind, onPushT, syncAt}
const bjHMS = (t) => {
  const d = new Date(t + BJ);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const fmtDur = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return m ? `${m}分${s % 60}秒` : `${s}秒`;
};

function wxPresencePost(uid, s) {
  const nick = WX_ROOM.get(uid);
  if (!nick || !INGEST || WX_PUSH_OFF) return;
  s.syncAt = Date.now();
  fetch(SITE + '/api/wxq/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
    body: JSON.stringify({
      items: [], u: String(uid), who: nick,
      state: {
        online: s.online ? 1 : 0, onT: s.onT || 0, actT: s.at || 0,
        lastKind: s.kind || 'action', nimAt: Date.now(), src: 'nim',
      },
    }),
    signal: AbortSignal.timeout(12000),
  }).catch((e) => log('[在线] 上报失败：' + String((e && e.message) || e).slice(0, 50)));
}

/** 她任何一个可观测动作都算在线心跳。kind: text/gift/live/small… */
function wxTouch(uid, t, kind) {
  const id = Number(uid) || 0;
  const nick = WX_ROOM.get(id);
  if (!nick) return;                       // 粉丝的动作一律不看，零开销
  const nowAt = Date.now();
  const at = Math.min(Number(t) || nowAt, nowAt);   // 服务端时间偶尔比本地快
  let s = wxPresence.get(id);
  if (!s) { s = { online: false, onT: 0, at: 0, kind: '', onPushT: 0, syncAt: 0 }; wxPresence.set(id, s); }
  if (at < s.at - 60e3) return;            // 明显乱序的老消息，别拿它当时针
  const wasOffline = !s.online;
  if (at > s.at) { s.at = at; if (kind) s.kind = kind; }
  if (wasOffline) {
    s.online = true;
    s.onT = s.at;
    /* 冷却：她静默 6 分钟被我们判下线、又说一句 ⇒ 会连环报上下线。
       跟 Actions 同口径（阈值 5 分钟时冷却也 5 分钟）。 */
    if (s.at - (s.onPushT || 0) >= WX_ON_COOLDOWN) {
      wxBuf.push({ id: 'on:' + s.at, t: s.at, who: nick, text: `💡${bjHMS(s.at)}${nick} 上线了` });
      s.onPushT = s.at;
      log(`[在线] ${nick} 上线 ${bjHMS(s.at)}（${kind || '动作'}）`);
    }
    wxPresencePost(id, s);
    return;
  }
  if (nowAt - s.syncAt > 60e3) wxPresencePost(id, s);   // actT 刷新（节流 1 分钟一次）
}

/** 静默超阈值 ⇒ 下线。延迟最多 20 秒（定时器粒度），不再靠 5 分钟一轮的 Actions。 */
function wxPresenceTick() {
  const now = Date.now();
  for (const [uid, s] of wxPresence) {
    if (!s.online) continue;
    if (now - s.at < WX_ONLINE_MS) continue;
    const nick = WX_ROOM.get(uid) || '';
    s.online = false;
    const offT = s.at + WX_ONLINE_MS;          // 她真正停下的那一刻，不是判定时刻
    const dur = Math.max(0, Math.round((offT - (s.onT || s.at)) / 1000));
    const bjHour = new Date(offT + BJ).getUTCHours();
    if (bjHour >= 8 && nick) {                 // 夜里不推下线，免得吵人（与 Actions 一致）
      wxBuf.push({
        id: 'off:' + s.at, t: offT, who: nick,
        text: `🕑${bjHMS(offT)}${nick} 下线了\n在线时长${fmtDur(dur)}`,
      });
      log(`[在线] ${nick} 下线 ${bjHMS(offT)}（在线 ${fmtDur(dur)}）`);
    } else {
      log(`[在线] ${nick} 下线 ${bjHMS(offT)}（${bjHour < 8 ? '夜间不推' : '不在播报名单'}）`);
    }
    s.onT = 0;
    wxPresencePost(uid, s);
  }
}
setInterval(wxPresenceTick, 20e3);

/* 重启后把云端在线状态接回来。
 * 为什么必须有：容器/进程一重启，内存里的 lastAct 全空 ⇒ 她「1 分钟前刚说过话」会被
 * 当成刚上线，群里诈一条「上线了」；反过来已经在线的也会被当成离线再补一条下线。
 * 恢复失败不影响功能，只是这一轮可能多一条假播报。 */
async function wxPresenceRestore() {
  if (!INGEST) return;
  for (const [uid, nick] of WX_ROOM) {
    try {
      const r = await fetch(`${SITE}/api/wxq/state?u=${uid}`, {
        headers: { 'x-ingest-token': INGEST }, signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => null);
      const s0 = (j && j.state) || {};
      const at = Number(s0.actT) || 0;
      if (!at) continue;
      const cur = wxPresence.get(uid);
      if (cur && cur.at >= at) continue;          // 内存里的更新，别拿旧状态盖回去
      wxPresence.set(uid, {
        online: Number(s0.online) === 1 && Date.now() - at < WX_ONLINE_MS,
        onT: Number(s0.onT) || at, at,
        kind: String(s0.lastKind || 'restore'),
        onPushT: Number(s0.onT) || at, syncAt: 0,
      });
      log(`[在线] 恢复 ${nick}：${Number(s0.online) === 1 ? '在线' : '离线'}，最后动作 ${bjHMS(at)}`);
    } catch { /* 忽略：恢复失败只是可能多一条播报 */ }
  }
}
if (INGEST) setTimeout(() => { void wxPresenceRestore(); }, 6000);

/* 语音转文字（2026-11-14 站长：「能语音直接转文字吗」）。
 * 本机常驻服务 /app/asr/asr-server.mjs（Paraformer 中文模型，不调外部 API），
 * 只听 127.0.0.1，超时 20 秒；失败就返回空串，调用方退回发语音原声。
 * 🔴 转写会慢 1–3 秒，但队列本来就是每 10 秒 pump 一次，不影响及时性；
 *    同一条语音被 Actions 和长连接各看到一次也无所谓，服务端按 URL 缓存。 */
const ASR_URL = process.env.ASR_URL || 'http://127.0.0.1:8799/asr';
async function asrOf(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return '';
  try {
    const r = await fetch(ASR_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: String(u) }), signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => null);
    return (j && j.ok && j.text) ? String(j.text).trim() : '';
  } catch { return ''; }
}

function wxQueue(uid, v, d) {
  if (!WX_ROOM.has(uid)) return;
  const nick = WX_ROOM.get(uid);
  const t = Number(v.t) || Number(d.time) || Date.now();
  wxTouch(uid, t, v.k);      // 发言本身就是「人在线」的硬证据（任何房间都算）
  const head = `【${nick}·口袋房间】`;
  const txt = String(v.x || '').trim();
  /* 语音：先转文字，转出来只发文字（她说的话就是内容）；
     转不出来才发原声（桥用 wx messages send --voice），保证不丢信息。 */
  const voice = String(v.a || '').trim();
  if (voice) {
    void (async () => {
      const asr = await asrOf(voice);
      const line = asr ? `🎙 ${asr}` : '🎙 语音（转写失败，听原声）';
      /* 语音在前：她说的话才是内容；引用（↳ @粉丝：原话）跟在后一行。 */
      const body = line + (txt ? '\n' + txt : '');
      wxBuf.push({
        id: `room:${uid}:${t}`, t, who: nick,
        text: `${head}${wxClock(t)}\n${body}`,
        voice: asr ? '' : voice,
      });
      log(`[WX] 入队 ${nick} ${v.k} ${line.slice(0, 26)}`);
    })();
    return;
  }

  if (txt) wxBuf.push({ id: `room:${uid}:${t}`, t, who: nick, text: `${head}${wxClock(t)}\n${txt}` });
  /* 图片单独成条、text 留空（与 Actions 同口径）：桥拿到 img 才下载真发一张；
     合进文本里发不出去，URL 贴出来就是一行丑链接。 */
  const imgs = Array.isArray(v.i) ? v.i.filter(Boolean) : [];
  for (const iu of imgs.slice(0, 3)) {
    /* id 与 Actions 完全同规则（`roomimg:<uid>:<t>`），多图和单图都只发第一条 id，
       避免两条通道各发一张。 */
    wxBuf.push({ id: `roomimg:${uid}:${t}`, t, who: nick, text: '', img: iu });
  }
  if (txt || imgs.length) log(`[WX] 入队 ${nick} ${v.k} ${txt.slice(0, 24)}${imgs.length ? ' 〔图' + imgs.length + '〕' : ''}`);
}

async function flushWx() {
  if (!wxBuf.length) return;
  if (WX_PUSH_OFF) { for (const it of wxBuf.splice(0)) log('[DRY] 会推微信：' + it.text.replace(/\n/g, ' / ')); return; }
  const batch = wxBuf.splice(0, wxBuf.length);
  /* 一个 body 只带一个 who（桥靠 who 决定发哪个群），按人分组投 */
  const byWho = new Map();
  for (const it of batch) {
    if (!byWho.has(it.who)) byWho.set(it.who, []);
    byWho.get(it.who).push(it);
  }
  for (const [who, items] of byWho) {
    try {
      const r = await fetch(SITE + '/api/wxq/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
        body: JSON.stringify({ items, u: '', who }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json().catch(() => ({}));
      wxFail = 0;
      log(`[WX] 已投 ${items.length} 条 → 队列 ${j && j.q != null ? j.q : '?'}`);
    } catch (e) {
      wxFail += 1;
      log(`[WX] 投递失败（第 ${wxFail} 次）：${String(e?.message || e).slice(0, 60)}`);
      /* 失败要放回队首重投，否则她这几句话就丢了。连续失败太多就丢掉最老的，防内存涨。 */
      if (wxFail <= 6) wxBuf.unshift(...items);
    }
  }
}
setInterval(() => { flushWx().catch((e) => log('[WX] flush 异常 ' + String(e?.message || e).slice(0, 50))); }, 900);
/* 播报名单每 5 分钟跟云端对一次（取关/关注在群里改完，这里最慢 5 分钟跟上）。 */
if (INGEST) {
  setTimeout(() => { void wxRoomLoad(); }, 3000);
  setInterval(() => { void wxRoomLoad(); }, 5 * 60e3);
}


/* 上报：{ msgs: { uid: [view…] } }，与 sync.mjs 完全同一口径、同一去重（t|k） */
async function flushMsgs() {
  if (!WRITE_MSG || !msgQ.size) { if (!WRITE_MSG) msgQ.clear(); return; }
  const uids = [...msgQ.keys()];
  const BATCH = 60;
  for (let i = 0; i < uids.length; i += BATCH) {
    const part = {};
    for (const uid of uids.slice(i, i + BATCH)) part[uid] = msgQ.get(uid);
    try {
      const r = await post('/api/ingest', { msgs: part });
      for (const uid of uids.slice(i, i + BATCH)) msgQ.delete(uid);
      log(`msgs +${JSON.stringify(r?.added ?? r ?? {}).slice(0, 80)}`);
    } catch (e) {
      log('msgs 上报失败：' + String(e.message).slice(0, 100));
      break;                                   // 留着下一轮，别把队列打散
    }
  }
}

/* ---------------- 消息 → 统一事件 ---------------- */
function giftFromExt(ext, { src, liveId, roomId, fallbackMid, msgTime, uid }) {
  const gi = ext?.giftInfo || ext?.giftText?.giftInfo;
  if (!gi) return null;
  const g = String(gi.giftName || '').trim();
  const num = Math.max(1, Math.floor(Number(gi.giftNum) || 1));
  if (!g) return null;
  const u = ext.user || {};
  const acc = ext.acceptUser || {};
  const mid = Number(acc.userId) || Number(fallbackMid) || 0;
  if (!mid) return null;
  const t = Number(msgTime) || Date.now();
  /* 🔴 单价：giftInfo 里**根本没有 money 字段**（实测官方 message/list 与云信推送都没有），
   *   原来 `Number(gi.money) || 0` 一律得 0 ⇒ 鸡腿榜全部记为 0 分。
   *   必须走本地价目表 lib/gift-price.mjs（和旧源 gift-sync 同一张表，口径一致）。 */
  const v = Number(gi.money) || priceOf(gi.giftId, g) || 0;
  return {
    uid,
    t, mid,
    sid: Number(u.userId) || 0,
    sn: String(u.nickName || u.nickname || u.userName || '').slice(0, 40),
    g, gid: String(gi.giftId || ''),
    num, v,
    src,                      // 0=房间 1=直播
    liveId, roomId,
    day: bjDay(t),
  };
}

/* ---------------- 健康心跳 + 空档账本（兜底方案的地基） ----------------
 * 🔴 为什么必须记空档：云信是长连接，**断线期间的消息不会重发**。
 *    断线时长就是数据缺口。如果不把「缺口时间窗」写下来，重连后进程看起来一切正常，
 *    缺口却永久留在库里 —— 这就是「静默丢数据」，比对账发现少分更可怕。
 *    记账之后，重连时按窗口去补：
 *      · 房间侧：NIM 历史 / 官方 homeowner `message/list` 按 nextTime 游标往后翻（同源，天然幂等）
 *      · 直播侧：播完即删、没有回放，只能走官方对账补差（只增不删，带 reconciled 窄窗去重）
 */
const STATE_DIR = resolve(ROOT, 'nim-state');
const HEALTH = resolve(STATE_DIR, 'health.json');
const GAPLOG = resolve(STATE_DIR, 'gap.jsonl');
try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* ignore */ }

let lastRoomAt = 0, lastLiveAt = 0;
let downFrom = 0;            // 本次掉线起点（0 = 当前在线）
let reconnecting = false;

function noteGap(kind, from, to) {
  try {
    if (!from || !to || to <= from) return;
    writeSync(openSync(GAPLOG, 'a'), JSON.stringify({ kind, from, to, at: Date.now() }) + '\n');
    log(`[GAP] ${kind} 缺口 ${new Date(from + BJ).toISOString().slice(5, 19)} → ${new Date(to + BJ).toISOString().slice(5, 19)}（${Math.round((to - from) / 1000)}s），已记账待补`);
  } catch (e) { log('[GAP] 记账失败 ' + String(e.message).slice(0, 80)); }
}

function writeHealth(extra) {
  try {
    writeFileSync(HEALTH, JSON.stringify(Object.assign({
      at: Date.now(),
      pid: process.pid,
      qchat: qchatReady ? 1 : 0,
      subscribed: subscribedSrv.size,
      alive: srvListRef.length - deadSrv.size,
      dead: deadSrv.size,
      lives: lives.size,
      giftQ: giftQ.length,
      lvQ: lvQ.length,
      lastRoomAgo: lastRoomAt ? Math.round((Date.now() - lastRoomAt) / 1000) : -1,
      lastLiveAgo: lastLiveAt ? Math.round((Date.now() - lastLiveAt) / 1000) : -1,
      downSec: downFrom ? Math.round((Date.now() - downFrom) / 1000) : 0,
      /* 房间消息类型分布：判断「有消息但礼物 0 行」到底卡在哪一环 */
      stat,
      subscribedList: [...subscribedSrv],
      /* 失败名单（带成员名），用来判断「订不上」是房间死了还是账号没权限 */
      failN: subFail.size,
      failList: [...subFail.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 60)
        .map(([srv, n]) => {
          const mid = srvToMid.get(srv) || 0;
          const nm = midName.get(mid) || '?';
          return `${srv}:${nm}:${n}`;
        }),
    }, extra || {})));
  } catch { /* ignore */ }
}

/* ---------------- QChat：成员房间 ---------------- */
let qchatClient = null;
let qchatReady = false;
const srvToMid = new Map();
const midName = new Map();     // mid → 成员名（health 里报失败房间用）
/* 房间消息计数（health 输出）：msg=总消息 / text=非礼物发言 / present=礼物类型 /
 * giftOK=成功解析写入 / giftNull=礼物但解析失败 / types=原始 messageType 分布 */
const stat = { msg: 0, text: 0, present: 0, giftOK: 0, giftNull: 0, lastType: '', types: {} };
const subscribedSrv = new Set();
const subFail = new Map();     // srv → 连续失败次数（瞬时失败不能当永久失效）
let srvListRef = [];

/* 🔴 毕业/暂休房间永久黑名单（2026-11-11 站长口径：
 *   「这些人我们之前已经拉过历史消息了呀，有的在的就行了呀，就不管了」）
 *   实测 511 个 srv 里只有 244 间还活着，剩下 267 间全是四到六期生（沈梦瑶、费沁源、
 *   孙珍妮、苏杉杉、郑丹妮、袁一琦、周诗雨、王奕…），房间早关了，订阅永远 failedServers。
 *   以前每 3 分钟拿 267 个死房间去问服务端，纯属烧配额、还可能触发限流把活房间挤掉。
 *   ⇒ 连续失败 3 次就写进 nim-state/dead-srv.json，之后连问都不问。 */
const DEAD_FILE = resolve(ROOT, 'nim-state/dead-srv.json');
const deadSrv = new Set();
try {
  if (existsSync(DEAD_FILE)) {
    for (const s of JSON.parse(readFileSync(DEAD_FILE, 'utf8')).servers || []) deadSrv.add(String(s));
  }
} catch { /* ignore */ }
function markDead(s) {
  if (deadSrv.has(s)) return;
  deadSrv.add(s);
  try {
    mkdirSync(dirname(DEAD_FILE), { recursive: true });
    writeFileSync(DEAD_FILE, JSON.stringify({
      at: Date.now(),
      note: '毕业/暂休房间，订阅恒失败，不再重试（站长口径：历史消息已拉过，不再管）',
      count: deadSrv.size,
      servers: [...deadSrv],
    }, null, 1));
  } catch { /* ignore */ }
}

/* 🔴🔴 2026-11-11 实测更正（推翻了「单连接 244 上限」的判断）：
 *   1. 单连接订阅**没有 244 的天花板** —— 全新连接一轮就能订到 337 间以上，
 *      之前卡在 244 是我自己的 bug（失败的 server 被永久 delete，再也不重试）。
 *   2. **多连接分片行不通**：云信按「同账号单点登录」处理，第 2 条连接登录时
 *      会把第 1 条踢掉（日志里 `云信连接已关闭`），4 路会互相踢成 0 覆盖。
 *   ⇒ 结论：**单连接 + 反复补订收敛**才是正解。每轮把还失败的按批重订，
 *      每 3 分钟一轮，失败计数到 12 次才放弃（真·无效 server）。
 *      SUB_PER_CONN 保持很大就只会开 1 条连接；将来若拿到多账号，再按账号分片。 */
const conns = [];
const SUB_PER_CONN = Math.max(200, Number(process.env.SUB_PER_CONN || 100000));
const SUB_GIVE_UP = 3;     // 连续 3 次失败 = 房间已关闭（毕业/暂休），拉黑不再重试

function refreshQchatReady() { qchatReady = conns.some((c) => c.ready); }

/* ---------------- 载荷解包（礼物到底藏在哪一层） ----------------
 * 🔴🔴 2026-11-11 致命 bug（对照官方 message/list 才查出来的）：
 *   我原来只读 `ext.messageType`，还只匹配 `^PRESENT`。真实结构是：
 *     官方 message/list: { msgType:"GIFT_TEXT", bodys:"{giftInfo,messageType}", extInfo:"{user}" }
 *     ⇒ 类型字段有三种写法（messageType / msgType），载荷可能在 ext / attachment / body 三处，
 *        礼物的值也不叫 PRESENT_*，房间侧大量是 **GIFT_TEXT**。
 *   结果：所有房间礼物都被判成「空类型」当发言丢掉，stat 里 present 恒为 0。
 *   现在：三处全合并，类型统一大写成一组正则，有 giftInfo 就直接当礼物。 */
const _J = (s) => {
  if (!s) return null;
  if (typeof s === 'object') return s;
  const t = String(s).trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return null;
  try { return JSON.parse(t); } catch { return null; }
};
function unpack(d) {
  const ext = _J(d.ext) || {};
  const att = _J(d.attachment) || {};
  const body = _J(d.body) || {};
  const merged = { ...body, ...att, ...ext };      // ext 优先级最高
  const mt = String(merged.messageType || merged.msgType || ext.type || '').toUpperCase();
  const giftInfo = merged.giftInfo || merged.giftText?.giftInfo || null;
  const user = merged.user || null;
  const acceptUser = merged.acceptUser || null;
  const isGift = !!giftInfo || /PRESENT|GIFT/.test(mt);
  return { ext, att, body, merged, mt, giftInfo, user, acceptUser, isGift };
}

/* 🔴🔴 云信房间礼物**一笔礼物两条消息**（2026-11-11 03:11:55 实测抓到）：
 *     `GIFT_TEXT`       琴音生花 ×1 msgIdServer=7486656808   ← 礼物横幅
 *     `PRESENT_NORMAL`  琴音生花 ×1 msgIdServer=7486705848   ← 正式送礼
 *   同一成员、同一礼物、同份数，时间差几十毫秒，但 **msgIdServer 不同**，
 *   所以按消息 ID 去重完全无效，两条都会入库 ⇒ 红蓝分/鸡腿直接翻倍。
 *   ⇒ 礼物先进 2 秒缓冲，按 (成员+礼物+份数) 合并，优先保留 PRESENT_*。 */
const giftBuf = [];
function bufferGift(item, isPresent) { giftBuf.push({ item, isPresent, at: Date.now() }); }
function drainGiftBuf(force) {
  const now = Date.now();
  const ready = [];
  for (let i = giftBuf.length - 1; i >= 0; i--) {
    if (force || now - giftBuf[i].at >= 2000) ready.push(giftBuf.splice(i, 1)[0]);
  }
  if (!ready.length) return;
  const kept = new Map();
  for (const g of ready) {
    const k = `${g.item.mid}|${g.item.gid}|${g.item.g}|${g.item.num}`;
    const prev = kept.get(k);
    if (!prev) { kept.set(k, g); continue; }
    if (g.isPresent && !prev.isPresent) kept.set(k, g);      // 正式送礼优先
  }
  stat.dup = (stat.dup || 0) + (ready.length - kept.size);
  for (const g of kept.values()) pushItem(g.item);
}
setInterval(() => drainGiftBuf(false), 1000);

function onRoomMessage(d) {
  const p = unpack(d);
  const tk = p.mt || (p.giftInfo ? 'GIFT?' : '(空)');
  stat.msg++; stat.types[tk] = (stat.types[tk] || 0) + 1;
  if (!p.isGift) {
    stat.text++;
    if (stat.lastType !== tk) { stat.lastType = tk; if (DEBUG) log('[ROOM 非礼物]', tk, String(d.body || '').slice(0, 60)); }
    pushMsg(d, p); return;   // 非礼物 = 发言（文字/语音/视频/图片/翻牌…）
  }
  stat.present++;
  /* 她给别人送礼 = 她人在手机上（粉丝送给她不算：送礼人不是播报对象）。 */
  const giverUid = Number((p.user && p.user.userId) || 0);
  if (giverUid) wxTouch(giverUid, Number(d.time) || Date.now(), 'gift');
  const mid = srvToMid.get(String(d.serverId)) || 0;
  const item = giftFromExt(p.merged, {
    src: 0, liveId: '', roomId: d.channelId, fallbackMid: mid,
    msgTime: Number(d.time) || Date.now(), uid: 'room:' + (d.msgIdServer || d.uuid || d.msgIdClient || ''),
  });
  if (!item) { stat.giftNull++; if (DEBUG) log('[ROOM 礼物解析失败]', JSON.stringify(p.merged).slice(0, 200)); return; }
  stat.giftOK++;
  lastRoomAt = Date.now();
  log('[ROOM 礼物]', p.mt, item.g, '×' + item.num, 'v=' + item.v, '→', item.sn || item.mid);
  bufferGift(item, /PRESENT/.test(p.mt));   // 2 秒合并：GIFT_TEXT + PRESENT_NORMAL 只算一笔
}

async function fillConn(conn) {
  if (!conn.ready) return;
  const missing = conn.chunk.filter((s) => !subscribedSrv.has(s) && !deadSrv.has(s) && (subFail.get(s) || 0) < SUB_GIVE_UP);
  if (!missing.length) return;
  for (let i = 0; i < missing.length; i += SUB_BATCH) {
    if (!conn.ready) break;
    const part = missing.slice(i, i + SUB_BATCH);
    try {
      const res = await conn.client.subscribe(part);
      for (const r of res.rooms || []) {
        const s = String(r.serverId);
        subscribedSrv.add(s);
        subFail.delete(s);
      }
      for (const f of res.failedServers || []) {
        const s = String(f);
        const n = (subFail.get(s) || 0) + 1;
        subFail.set(s, n);
        if (n >= SUB_GIVE_UP) markDead(s);      // 连续 3 次被服务端拒 = 房间已关，永久跳过
      }
    } catch (e) {
      /* 🔴 这里是「连接层异常」，不是「房间被拒」——绝不能计入 subFail，
         否则一次网络抖动就把一批活房间误判成毕业房间拉黑。 */
      log(`[SUB${conn.idx}] 批次异常 ${String(e?.message || e).slice(0, 50)}，本轮中止`);
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const ok = conn.chunk.filter((s) => subscribedSrv.has(s)).length;
  log(`[SUB${conn.idx}] ${ok}/${conn.chunk.length}（死房间已拉黑 ${deadSrv.size}）`);
}

function spawnConn(creds, conn) {
  // 记下启动时刻：万一 connect() 卡死（既没成功也没报错），看门狗要能认出来
  if (!conn.ready) conn.downFrom = Date.now();
  const c = new NimCommonlinkQChatClient({
    appKey: APP_KEY, account: creds.account, token: creds.token,
    onRawPacket: rawRec ? (layer, packet, via) => rawRec.note(layer, packet, via) : undefined,
    onMessage: onRoomMessage,
    onConnected() {
      /* 🔴🔴 这个大坑：qchat.cjs 的 onConnected 不是在 connect() 成功时回调，
       *   而是在 **每一次 subscribe() 成功后**（qchat.cjs:550）才回调。
       *   所以绝对不能在这里触发 fillConn —— 不订阅就不会回调、不回调就不订阅，
       *   首尾咬死，结果就是「连接看着正常、订阅永远 0 间」。
       *   真正确认登上的信号是 connect() 自己 resolve（见下面 .then）。
       *   这里只做幂等标记，重复回调无副作用。 */
      if (conn.ready) return;
      conn.ready = true;
      conn.retry = 0;
      refreshQchatReady();
      log(`QChat[${conn.idx}] 已连接（本片 ${conn.chunk.length} 间）`);
      if (conn.downFrom) { noteGap('room', conn.downFrom, Date.now()); conn.downFrom = 0; }
      lastRoomAt = Date.now();
    },
    onDisconnected() {
      conn.ready = false;
      refreshQchatReady();
      if (!conn.downFrom) conn.downFrom = Date.now();
      log(`QChat[${conn.idx}] 断开`);
    },
    onError(e) {
      conn.ready = false;
      refreshQchatReady();
      if (!conn.downFrom) conn.downFrom = Date.now();
      log(`QChat[${conn.idx}] 错误：` + (e?.message || e));
    },
  });
  conn.client = c;
  c.connect().then(() => {
    /* 这里才是「真的登上了」—— 立刻开订，别等 onConnected（见上面的坑） */
    if (!conn.ready) {
      conn.ready = true;
      conn.retry = 0;
      refreshQchatReady();
      log(`QChat[${conn.idx}] 登录成功，开始订阅 ${conn.chunk.length} 间`);
      if (conn.downFrom) { noteGap('room', conn.downFrom, Date.now()); conn.downFrom = 0; }
      lastRoomAt = Date.now();
    }
    void fillConn(conn);
  }).catch((e) => {
    conn.ready = false;
    refreshQchatReady();
    if (!conn.downFrom) conn.downFrom = Date.now();
    /* 🔴 必须指数退避：云信对「同账号高频重登」会直接关 socket（报错长这样：
     *   「云信连接已关闭」——其实是服务端 reject，不是本地断的）。
     *   每 8 秒硬刚一次只会越撞越死，实测连 79 秒都上不去。
     *   退避 8→15→30→60 秒封顶，连上后清零。 */
    conn.retry = (conn.retry || 0) + 1;
    const wait = Math.min(60000, 8000 * Math.pow(2, Math.min(conn.retry - 1, 3)));
    log(`QChat[${conn.idx}] 连接失败 ${String(e?.message || e).slice(0, 60)}，${Math.round(wait / 1000)} 秒后重连（第 ${conn.retry} 次）`);
    setTimeout(() => { try { c.destroy(); } catch { /* ignore */ } spawnConn(creds, conn); }, wait);
  });
}

function attachQChat(creds, srvList) {
  const n = Math.ceil(srvList.length / SUB_PER_CONN) || 1;
  for (let i = 0; i < n; i++) {
    const chunk = srvList.slice(i * SUB_PER_CONN, (i + 1) * SUB_PER_CONN);
    const conn = { idx: i, chunk, client: null, ready: false, downFrom: 0 };
    conns.push(conn);
    // 每片错开 1.5 秒握手，别在同一秒把 3 条长连接砸上去
    setTimeout(() => spawnConn(creds, conn), i * 1500);
  }
  log(`QChat 分片 ${n} 路 × 约 ${SUB_PER_CONN} 间（共 ${srvList.length} 间）`);
}

/* 增量补订：把各片还没订上的房间反复补齐（每 3 分钟一轮） */
async function ensureSubscribed() {
  if (process.env.NO_ROOM === '1') return;
  for (const conn of conns) {
    if (conn.ready) await fillConn(conn);
  }
  const alive = srvListRef.filter((s) => !deadSrv.has(s));
  const still = alive.filter((s) => !subscribedSrv.has(s));
  if (still.length) log(`[SUB+] 覆盖 ${subscribedSrv.size}/${alive.length}（活房间）| 死房间拉黑 ${deadSrv.size} | 缺 ${still.length}`);
}

/* ---------------- Chatroom：直播 ---------------- */
const lives = new Map();   // liveId → { roomId, ownerId, ownerName, client, connected }

function attachLive(creds, live) {
  const entry = { ...live, connected: false };
  const client = new NimCommonlinkChatroomClient({
    appKey: APP_KEY, account: creds.account, token: creds.token, roomId: live.roomId,
    onRawPacket: rawRec ? (packet, via) => rawRec.note('chatroom', packet, via) : undefined,
    onConnected() {
      entry.connected = true;
      log(`[LIVE] 已连 ${live.ownerName} (${live.roomId})`);
      if (entry.downFrom) { noteGap('live', entry.downFrom, Date.now()); entry.downFrom = 0; }
      lastLiveAt = Date.now();
    },
    onDisconnected() {
      entry.connected = false;
      if (!entry.downFrom) entry.downFrom = Date.now();
    },
    onError(e) {
      entry.connected = false;
      if (!entry.downFrom) entry.downFrom = Date.now();
      log(`[LIVE] ${live.ownerName} 错误 ${e?.message || e}`);
    },
    onMessage(d) {
      /* 直播侧同一条铁律：礼物可能在 remoteExtension / msg_attach_ / custom 三处，
         类型可能是 PRESENT_* 也可能是 GIFT_*，一律交给 unpack 统一判定。 */
      const p = unpack({
        ext: d.remoteExtension || d.custom,
        attachment: d.msg_attach_,
        body: d.text,
      });
      if (!p.isGift) return;
      const item = giftFromExt(p.merged, {
        src: 1, liveId: live.liveId, roomId: live.roomId,
        fallbackMid: live.ownerId, msgTime: Number(d.time) || Date.now(),
        uid: 'live:' + (d.uuid || ''),
      });
      if (!item) return;
      lastLiveAt = Date.now();
      log('[LIVE 礼物]', p.mt, item.g, '×' + item.num, 'v=' + item.v, '→', item.sn || item.mid);
      bufferGift(item, /PRESENT/.test(p.mt));   // 直播侧同理：横幅 + 正式送礼合并成一笔
    },
  });
  entry.client = client;
  lives.set(String(live.liveId), entry);
  client.connect().catch((e) => log(`[LIVE] ${live.ownerName} 连接失败 ${String(e?.message || e).slice(0, 60)}`));
}

async function pollLives(creds) {
  try {
    const d = await pocket('/live/api/v1/live/getLiveList', { debug: false, next: '0', groupId: 12, record: false });
    const list = d?.content?.liveList || [];
    const seenIds = new Set();
    for (const x of list) {
      const liveId = String(x.liveId);
      seenIds.add(liveId);
      if (lives.has(liveId)) continue;
      if (lives.size >= MAX_LIVE) break;
      const one = (await pocket('/live/api/v1/live/getLiveOne', { liveId }))?.content || {};
      if (!one.roomId) continue;
      attachLive(creds, {
        liveId, roomId: String(one.roomId),
        ownerId: String(one.user?.userId || x.userId || ''),
        ownerName: String(one.user?.userName || x.nickname || ''),
      });
      await new Promise((r) => setTimeout(r, 120));
    }
    // 收拾已下播的
    for (const [id, e] of lives) {
      if (seenIds.has(id)) continue;
      try { e.client.destroy(); } catch { /* ignore */ }
      lives.delete(id);
      log(`[LIVE] 下播 ${e.ownerName}`);
    }
  } catch (e) {
    log('直播列表拉取失败：' + String(e?.message || e).slice(0, 90));
  }
}

/* ---------------- 启动 ---------------- */
(async () => {
  log(`启动${DRY ? '（DRY 不写库）' : ''} site=${SITE}`);
  const creds = await nimCredentials();
  log('云信身份：' + creds.account);

  const roster = await loadRoster();
  const srvList = [...new Set(roster.map((m) => String(m.srv)).filter(Boolean))];
  for (const m of roster) {
    srvToMid.set(String(m.srv), Number(m.id));
    midName.set(Number(m.id), m.n || '');
    memberIds.add(Number(m.id));
  }
  log(`名册 ${roster.length} 人 / ${srvList.length} 个房间服务器（已拉黑死房间 ${deadSrv.size}）`);

  srvListRef = srvList;
  /* 🔴🔴 2026-11-11 实测铁律：云信的「房间(QChat)」和「直播(Chatroom)」是两套服务，
   *   但登录用的是**同一个 NIM 账号** —— 同账号单点会话，本机两路连接会互相踢死。
   *   证据：02:41:24 直播连上 → 02:41:54 QChat 掉线 91s → 再重连一律失败。
   *   ⇒ 一个账号只能跑一路。房间用主号，直播另开一个号（NO_LIVE / NO_ROOM 分工）。
   *   NO_LIVE=1：只跑房间，不碰直播（推荐，房间侧补的是历史空白）。 */
  const NO_LIVE = process.env.NO_LIVE === '1';
  if (process.env.NO_ROOM === '1') log('NO_ROOM=1：跳过房间订阅，只跑直播');
  else attachQChat(creds, srvList);
  if (process.env.NO_ROOM !== '1' && !NO_LIVE) {
    /* 同号必踢：等 QChat 就绪再起直播，别到点硬接 */
    for (let i = 0; i < 120 && !qchatReady; i++) await new Promise((r) => setTimeout(r, 1000));
    log(`QChat 就绪=${qchatReady ? '是' : '否'}，订阅 ${subscribedSrv.size} 间，开始接直播`);
  }
  if (NO_LIVE) log('NO_LIVE=1：只跑房间，跳过直播连接（避免同号互踢）');
  else await pollLives(creds);
  setInterval(() => { void ensureSubscribed(); }, 180000);   // 每 3 分钟补订缺口
  if (!NO_LIVE) setInterval(() => { void pollLives(creds); }, LIVE_POLL_MS);
  setInterval(() => { void flush(); }, REPORT_MS);
  setInterval(() => { writeHealth(); }, 30000);

  /* 看门狗①：QChat 掉线超过 90 秒就硬重启（destroy → 重新 connect → 重新订阅）
     软重连在 subscribe 循环里已经做了，但它只管「订阅阶段」；
     跑起来之后 Socket 静默断掉是不会自己回来的，必须外面兜一层。 */
  setInterval(() => {
    if (process.env.NO_ROOM === '1' || reconnecting) return;
    /* 按片判定：只重启「自己掉下去超过 90 秒」的那一片，别把好的连接一起拆了 */
    const dead = conns.filter((c) => !c.ready && c.downFrom && Date.now() - c.downFrom > 90000);
    if (!dead.length) { if (qchatReady) downFrom = 0; return; }
    reconnecting = true;
    for (const conn of dead) {
      log(`[WD] QChat[${conn.idx}] 掉线 ${Math.round((Date.now() - conn.downFrom) / 1000)}s，重启该片`);
      try { conn.client?.destroy(); } catch { /* ignore */ }
      conn.downFrom = Date.now();
      try { spawnConn(creds, conn); } catch (e) { log('[WD] 重启失败：' + String(e.message).slice(0, 80)); }
    }
    reconnecting = false;
  }, 30000);

  /* 看门狗②：假在线检测。
     Socket 可能「TCP 还活着、但服务端已经不推了」。511 个房间在 10:00–01:00 之间
     45 分钟一条礼物都没有 = 不可能，判假在线，整片重连。凌晨不判（房间本来就静）。 */
  setInterval(() => {
    if (process.env.NO_ROOM === '1' || !qchatReady || reconnecting) return;
    const bjH = new Date(Date.now() + BJ).getUTCHours();
    if (bjH < 10) return;
    if (!lastRoomAt) { lastRoomAt = Date.now(); return; }
    if (Date.now() - lastRoomAt < 45 * 60e3) return;
    log('[WD] 45 分钟零房间消息，判定假在线，全部重连');
    lastRoomAt = Date.now();
    for (const conn of conns) {
      conn.downFrom = Date.now();
      try { conn.client?.destroy(); } catch { /* ignore */ }
      try { spawnConn(creds, conn); } catch { /* ignore */ }
    }
  }, 60000);

  setInterval(() => {
    log(`状态 giftQ=${giftQ.length} lvQ=${lvQ.length} qchat=${qchatReady ? 'on' : 'off'} lives=${lives.size} 订阅=${subscribedSrv.size}`);
    writeHealth();
  }, 60000);

  const shutdown = () => { try { rawRec?.close(); } catch { /* ignore */ } log('收到退出信号，已收尾'); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
