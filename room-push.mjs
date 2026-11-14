/**
 * 王语晨 · 口袋房间消息 → 微信群（2026-11-11）
 * ===============================================
 * 站长口径：「可以发一下王语晨口袋房间的消息做主动推送，可以先发一下历史消息」。
 *
 * 数据源：口袋48 IM 消息接口（与 backfill-room-history.mjs 同一个 fetchMessagePage）
 *   POST /im/api/v1/team/message/list/homeowner
 *   每页上限 50 条，nextTime 往前翻。
 *
 * 🔴 只推「她本人发的」：extInfo.channelRole === '2'。
 *   粉丝发言 channelRole 是别的值，混进来就变成刷别人的话。
 *   另外跳过 LIVEPUSH（开播推送），那条由 live-notify.mjs 专门管，这里重复推会撞车。
 *
 * 用法：
 *   DRY=1 node room-push.mjs            # 只打印，不发
 *   HIST=20 node room-push.mjs          # 把最近 20 条合成一条发到群里
 *   HIST=0 node room-push.mjs           # 只发「上一轮之后的新消息」（实时用）
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fetchMessagePage } from './lib/api.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const envFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pickEnv = (txt, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};

const LIVE_ENV = envFile(ROOT + 'nim-sync.env');
const TOKEN = process.env.POCKET48_TOKEN || pickEnv(LIVE_ENV, 'POCKET48_TOKEN');
const NOTIFY_ENV = envFile(ROOT + 'live-notify.env');
const WX_PORT = process.env.WX_QUEUE_PORT || pickEnv(NOTIFY_ENV, 'WX_QUEUE_PORT') || '8789';
const WX_KEY = process.env.WX_QUEUE_TOKEN || pickEnv(NOTIFY_ENV, 'WX_QUEUE_TOKEN');
const WX_URL = `http://127.0.0.1:${WX_PORT}/say?k=${encodeURIComponent(WX_KEY)}`;

const UID = Number(process.env.ROOM_UID || 89653517);      // 王语晨
const NICK = process.env.ROOM_NICK || '王语晨';
const HIST = Math.max(0, Number(process.env.HIST ?? 20));   // 补多少条历史
const DRY = !!process.env.DRY;
const PAGE = Math.min(50, Math.max(20, Number(process.env.PAGE || 50)));
const MAXPAGE = Math.max(1, Number(process.env.MAXPAGE || 40));
const STATE = ROOT + 'nim-state/room-push.json';

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN（nim-sync.env）'); process.exit(1); }
if (!WX_KEY && !DRY) { console.error('缺少 WX_QUEUE_TOKEN（live-notify.env）'); process.exit(1); }

const BJ = 8 * 3600e3;
function bjTime(ms, withDate) {
  const d = new Date(ms + BJ);
  const p = (n) => String(n).padStart(2, '0');
  const hm = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  if (!withDate) return hm;
  return `${d.getUTCMonth() + 1}-${p(d.getUTCDate())} ${hm}`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 名册里拿 serverId / channelId */
const txt = readFileSync(ROOT + '../all48-worker/public/data/members.js', 'utf8');
const roster = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const me = roster.find((m) => Number(m.id) === UID);
if (!me || !me.srv || !me.ch) { console.error('名册里找不到 uid ' + UID); process.exit(1); }

/** 一条消息 → 一行文字；返回 null 表示不推 */
function line(m) {
  let ext = {};
  try { ext = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : (m.extInfo || {}); } catch { ext = {}; }
  if (String(ext.channelRole) !== '2') return null;          // 不是她本人
  const type = String(m.msgType || '');
  if (type === 'LIVEPUSH') return null;                      // 开播推送另管

  const t = Number(m.msgTime) || 0;
  let body = '';
  try { body = typeof m.bodys === 'string' ? m.bodys : JSON.stringify(m.bodys || {}); } catch { body = ''; }
  let content = '';
  if (type === 'TEXT') content = String(body || '').trim();
  else if (type === 'IMAGE') content = '[图片]';
  else if (type === 'AUDIO' || type === 'VOICE') {
    let sec = 0;
    try { sec = Number(JSON.parse(body).duration) || 0; } catch { }
    content = '[语音' + (sec ? ' ' + Math.round(sec / 1000) + '秒' : '') + ']';
  } else if (type === 'EXPRESSION' || type === 'EMOJI') content = '[表情]';
  else if (type === 'GIFT') return null;                     // 礼物消息不推
  else return null;

  if (!content) return null;
  return { t, type, text: content };
}

/* 从最新往回翻，取最近 want 条本人消息（want=0 时用 since 时间卡） */
async function collect(want, since) {
  const out = [];
  let nextTime = 0;
  for (let p = 0; p < MAXPAGE; p++) {
    const r = await fetchMessagePage({
      serverId: me.srv, channelId: me.ch, nextTime, limit: PAGE, token: TOKEN,
    });
    const msgs = r.messages || [];
    if (!msgs.length) break;
    for (const m of msgs) {
      const it = line(m);
      if (!it) continue;
      if (since && it.t <= since) continue;
      out.push(it);
      if (want && out.length >= want) return out.reverse();
    }
    if (!r.nextTime || r.nextTime === nextTime) break;
    nextTime = r.nextTime;
    await sleep(180);
  }
  return out.reverse();
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { lastT: 0 }; }
}
function saveState(s) {
  try { writeFileSync(STATE, JSON.stringify(s, null, 2)); } catch { }
}

async function send(text) {
  if (DRY) { console.log('[DRY] 会发：\n' + text); return true; }
  const r = await fetch(WX_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) { console.error('入队失败 HTTP ' + r.status); return false; }
  return true;
}

/* ---------------- 主流程 ---------------- */
const WATCH = process.argv.includes('--watch') || !!process.env.WATCH;
const EVERY = Math.max(15, Number(process.env.EVERY || 30)) * 1000;   // 轮询间隔（秒）

/** 跑一轮：有内容就发。返回发出条数 */
async function tick(first) {
  const st = loadState();
  const items = first && HIST > 0
    ? await collect(HIST, 0)
    : await collect(0, st.lastT || 0);

  if (!items.length) {
    if (!WATCH) console.log(first ? '没取到消息' : '没有新消息');
    return 0;
  }

  const newest = items[items.length - 1].t;
  console.log(new Date().toISOString().slice(11, 19), '取到 ' + items.length + ' 条，最新 ' + bjTime(newest, true));

  /* 🔴 一次连发好几条（她常连着刷）时合并成一条，避免在群里刷屏 */
  if (items.length === 1) {
    const it = items[0];
    await send(`【${NICK}·口袋房间】${bjTime(it.t, true)}\n${it.text}`);
  } else {
    const lines = items.map((it) => `${bjTime(it.t, true)}  ${it.text}`).join('\n');
    await send(`【${NICK}·口袋房间】${items.length} 条新消息\n${lines}`);
  }

  saveState({ lastT: newest, at: Date.now() });
  console.log('  已投递到微信队列');
  return items.length;
}

if (WATCH) {
  console.log('监听中：每 ' + Math.round(EVERY / 1000) + ' 秒看一次新消息（Ctrl+C 结束）');
  /* 🔴 只有「从来没跑过」才补历史。
     原先是 let first = true ⇒ 每次重启（含 launchd 自动拉起）都把 HIST 条历史重发一遍，群里刷屏。 */
  const had = !!loadState().lastT;
  let first = !had;
  if (had) console.log('已有进度（' + bjTime(loadState().lastT, true) + '），从新消息接着推');
  while (true) {
    try { await tick(first); } catch (e) { console.error('本轮失败：' + String(e.message).slice(0, 100)); }
    first = false;
    await sleep(EVERY);
  }
} else {
  await tick(true);
  console.log('完成');
}
