/**
 * 微信推送 · GitHub Actions 版（2026-11-12）
 * =====================================================
 * 为什么有这一版：站长不想依赖自己电脑常开，也不想为这事儿买服务器。
 * 仓库是 public ⇒ Actions 分钟数完全免费、不用绑卡 ⇒ 这是唯一「零成本 + 零门槛」的常驻方案。
 *
 * 数据流（全链路无服务器）：
 *   口袋48(getLiveList / 房间消息)
 *     → 本脚本（GitHub runner 里跑 ~4.5 分钟）
 *     → Cloudflare Worker 的 KV 队列 POST /api/wxq/push
 *     → 手机 AutoJS6 每 20 秒 GET /api/wxq 取件 → 发到「游戏群」
 *
 * 🔴 游标不放本地（runner 每次都是全新机器），统一放 Worker 的 wx:state：
 *    roomT   房间消息游标（毫秒）
 *    liveId  当前在播场次（空 = 没在播）
 *    miss    连续几次没在列表里（连续 3 次才算真下播，防抖）
 *    actT    最后一次「动作」的时间（开播/下播/发消息/翻牌都算）
 *    online  1 = 在线（最近 1 小时内有动作），0 = 静默
 *            ⚠️ 这是「动作心跳」推出来的，不是登录态 —— 口袋48 不公开登录接口。
 *            她挂着 App 但一直不说话，超过 1 小时会被判静默，这是这套模型已知的偏差。
 *
 * 🔴 只推「她本人」：extInfo.channelRole === '2'；跳过 LIVEPUSH（开播归本脚本的 live 分支管）。
 *
 * 用法（本地调试）：
 *   DRY=1 RUN_SECONDS=60 node wx-actions.mjs    # 只打印不投递
 *   node wx-actions.mjs                          # 跑一轮（默认 270 秒）
 */
import { postJson, fetchMessagePage } from './lib/api.mjs';

const WORKER = (process.env.WORKER_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const WATCH_UID = String(process.env.WATCH_UID || '89653517');   // 王语晨
const NICK = process.env.ROOM_NICK || '王语晨';
const SRV = String(process.env.ROOM_SRV || '2278592');
const CH = String(process.env.ROOM_CH || '2541547');

/* 🔴 多成员（2026-11-12 站长：「bot小群对接黄宣绮的口袋发言和直播 和上下线」）
   一个 runner 里跑几个人比开几个 job 便宜得多：直播列表是**全站一份**，取一次就够；
   只有房间消息要按人各拉一次。每个成员的游标在 worker 侧分开存（wx:state:<uid>），
   否则两个人共用一个 roomT/liveId 会互相踩。
   env 写法（JSON 数组）：WATCHES=[{"uid":"89653517","nick":"王语晨","srv":"2278592","ch":"2541547"},…]
   不配时退回老的单成员 WATCH_UID/ROOM_*。 */
const WATCHES = (() => {
  const raw = String(process.env.WATCHES || '').trim();
  if (raw) {
    try {
      const a = JSON.parse(raw);
      const ok = (Array.isArray(a) ? a : []).map((x) => ({
        uid: String(x.uid || '').trim(),
        nick: String(x.nick || x.name || '').trim(),
        srv: String(x.srv || '').trim(),
        ch: String(x.ch || '').trim(),
      })).filter((x) => x.uid && x.nick && x.srv && x.ch);
      if (ok.length) return ok;
      console.warn('WATCHES 里没有一条完整（uid/nick/srv/ch 都要），退回单成员');
    } catch (e) { console.warn('WATCHES 不是合法 JSON：' + e.message); }
  }
  return [{ uid: WATCH_UID, nick: NICK, srv: SRV, ch: CH }];
})();

const RUN = Math.max(45, Number(process.env.RUN_SECONDS || 270)) * 1000;
const EVERY = Math.max(10, Number(process.env.EVERY || 20)) * 1000;
const DRY = !!process.env.DRY;
const HDR = { 'x-ingest-token': INGEST, 'content-type': 'application/json' };

const BJ = 8 * 3600e3;
const p2 = (n) => String(n).padStart(2, '0');
function bjTime(ms, withDate) {
  const d = new Date((Number(ms) || Date.now()) + BJ);
  const hm = p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes());
  return withDate === false ? hm : `${d.getUTCMonth() + 1}-${p2(d.getUTCDate())} ${hm}`;
}
/** 站长要的样式：`[13:51:07]`（带秒）—— 上下线这种事件秒级才有意义 */
function bjHMS(ms) {
  const d = new Date((Number(ms) || Date.now()) + BJ);
  return '[' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + ']';
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }
if (!INGEST && !DRY) { console.error('缺 INGEST_TOKEN'); process.exit(1); }

/* ---------------- Worker 侧游标 / 队列 ---------------- */

/** 每个成员一份游标：?u=<uid> ⇒ worker 存 wx:state:<uid> */
async function stateGet(uid) {
  const r = await fetch(`${WORKER}/api/wxq/state?u=${encodeURIComponent(uid)}`, { headers: HDR, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('读游标 HTTP ' + r.status);
  const j = await r.json();
  const s = j && (j.state || j.data || j);
  return (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
}

async function push(items, state, who) {
  if (DRY) {
    for (const it of items) log('[DRY] 会推：' + it.text.replace(/\n/g, ' / '));
    log('[DRY] state =', JSON.stringify(state));
    return;
  }
  const r = await fetch(`${WORKER}/api/wxq/push`, {
    method: 'POST', headers: HDR,
    body: JSON.stringify({ items, state, u: who && who.uid, who: who && who.nick }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('投递 HTTP ' + r.status);
  const j = await r.json();
  if (j && j.added) log(`已入队 ${j.added} 条，队列共 ${j.q}`);
  return j;
}

/* ---------------- 数据源 ---------------- */

async function getLives() {
  const j = await postJson('/live/api/v1/live/getLiveList',
    { debug: false, next: '0', groupId: 12, record: false }, { token: TOKEN, retries: 2 });
  const list = (j && j.content && Array.isArray(j.content.liveList)) ? j.content.liveList : [];
  return list.map((x) => {
    const ui = x.userInfo || {};
    return {
      liveId: String(x.liveId || ''),
      uid: String(ui.userId || ''),
      name: String(ui.starName || ui.realNickName || ui.nickname || '').replace(/^[A-Z]+48-/, ''),
      title: String(x.title || ''),
      ctime: Number(x.ctime) || 0,
    };
  }).filter((x) => x.uid && x.liveId);
}

/** 从 bodys / attachment 里挖出可读文本。
 *  翻牌的字段名不固定：云信侧是 attachment.content.answer / text / content，
 *  网页/接口侧又可能是纯字符串或再套一层 JSON。逐层挖，挖不到返回空串。 */
function pickText(raw) {
  let o = raw;
  for (let i = 0; i < 3 && typeof o === 'string' && o; i++) {
    const s = o.trim();
    if (!s) return '';
    if (s[0] !== '{' && s[0] !== '[') return s;
    try { o = JSON.parse(s); } catch { return s; }
  }
  if (typeof o === 'string') return o.trim();
  if (!o || typeof o !== 'object') return '';
  const c = (o.content && typeof o.content === 'object') ? o.content : o;
  const arr = [c.answer, c.text, c.content, c.desc, c.question,
    o.answer, o.text, o.content, o.desc];
  for (const v of arr) if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

/** 一条 IM 消息 → {t,text} ；返回 null 表示不推 */
function line(m) {
  let ext = {};
  try { ext = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : (m.extInfo || {}); } catch { ext = {}; }
  if (String(ext.channelRole) !== '2') return null;        // 不是她本人
  const type = String(m.msgType || '');
  if (type === 'LIVEPUSH' || type === 'GIFT') return null;  // 开播另管 / 礼物不推

  let body = '';
  try { body = typeof m.bodys === 'string' ? m.bodys : JSON.stringify(m.bodys || {}); } catch { body = ''; }
  let content = '';
  if (type === 'TEXT') content = String(body || '').trim();
  else if (type === 'IMAGE') content = '[图片]';
  /* 🔴 翻牌（FLIPCARD_AUDIO / FLIPCARD_VIDEO）以前直接落到 else 被丢掉，
     2026-11-12 补上：翻牌是她最主动的动作之一，也是「上线」的重要信号。
     真实文本藏在 bodys 里，字段名三种写法都遇到过 ⇒ 统一交给 pickText 挖。 */
  else if (/^FLIPCARD/i.test(type) || type === 'AUDIO_GIFT_REPLY') {
    const txt = pickText(body);
    content = '[翻牌]' + (txt ? ' ' + txt : '');
  }
  else if (type === 'AUDIO' || type === 'VOICE') {
    let sec = 0;
    try { sec = Number(JSON.parse(body).duration) || 0; } catch { }
    content = '[语音' + (sec ? ' ' + Math.round(sec / 1000) + '秒' : '') + ']';
  } else if (type === 'EXPRESSION' || type === 'EMOJI') content = '[表情]';
  else return null;

  if (!content) return null;
  return { t: Number(m.msgTime) || 0, text: content };
}

/** 取 since 之后本人发的消息（最多往回翻 6 页，避免 runner 时间被吃光） */
async function collect(since, w) {
  const out = [];
  let nextTime = 0;
  for (let p = 0; p < 6; p++) {
    const r = await fetchMessagePage({ serverId: w.srv, channelId: w.ch, nextTime, limit: 50, token: TOKEN });
    const msgs = (r && r.messages) || [];
    if (!msgs.length) break;
    let oldest = Infinity;
    for (const m of msgs) {
      const it = line(m);
      const t = Number(m.msgTime) || 0;
      if (t && t < oldest) oldest = t;
      if (!it) continue;
      if (it.t && it.t > since) out.push(it);
    }
    // 这一页里最早的消息都已经比游标新 ⇒ 还得继续往前翻
    if (!(oldest > since)) break;
    if (!r.nextTime || r.nextTime === nextTime) break;
    nextTime = r.nextTime;
    await sleep(150);
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ---------------- 一轮（单个成员） ----------------
 * `lives` 由主循环**只取一次**（全站在播列表），几个人共用，省掉 N 次重复请求。
 * 返回下轮游标。文案统一成站长给的样式：`[13:51:07] 王语晨 上线了`。 */

async function tickOne(w, st, lives, first) {
  const items = [];
  const next = { ...st };
  /* 「她有没有动作」——本轮只要发现开播/下播/新消息/翻牌就算 true。
     这是「上线」判定的唯一依据（口袋48 不公开登录态，只能看动作）。 */
  let active = false;
  const add = (id, t, text) => items.push({ id, t, text, who: w.nick });

  /* ① 开播 / 下播 */
  let cur = null;
  if (lives) {
    cur = lives.find((x) => x.uid === w.uid) || null;
    if (first) log(`${w.nick}：${cur ? '正在播「' + cur.title + '」' : '没在播'}`);
  } else {
    next.err = 'live:unavailable';
  }

  if (cur) {
    next.miss = 0;
    /* 🔴 第一次跑（游标里没有 liveId）时如果她早就播了，不能补发「开播」——
       否则每台新机器上线都会在群里诈一句「开播了」，而直播可能已经播了两小时。
       口径跟 live-notify.mjs 一致：>30 分钟的直接静默记录。 */
    const startedAgo = cur.ctime ? Date.now() - cur.ctime : 0;
    const coldStart = !st.liveId && startedAgo > 30 * 60e3;
    if (cur.liveId !== (st.liveId || '') && !coldStart) {
      const mins = cur.ctime ? Math.max(0, Math.round((Date.now() - cur.ctime) / 60000)) : 0;
      add('live:' + cur.liveId + ':start', Date.now(),
        `【${w.nick}·开播】${cur.title || '直播中'}\n`
        + (mins > 5 ? `已经播了 ${mins} 分钟\n` : '')
        + `https://h5.48.cn/2017/live/index.html?liveId=${cur.liveId}`);
      log(`开播 → ${cur.liveId} 「${cur.title}」`);
    }
    active = true;                       // 在播 = 她肯定在线
    next.lastKind = 'live';              // 给上下线日志用（Worker 侧记进 wx:log）
    next.liveId = cur.liveId;
    next.liveTitle = cur.title;
    next.liveCtime = cur.ctime;
  } else if (st.liveId) {
    const miss = (Number(st.miss) || 0) + 1;
    next.miss = miss;
    if (miss >= 3) {                       // 连续 3 次（≈1 分钟）都没在列表里才算真下播
      const mins = st.liveCtime ? Math.max(1, Math.round((Date.now() - st.liveCtime) / 60000)) : 0;
      add('live:' + st.liveId + ':end', Date.now(),
        `【${w.nick}·下播】${mins ? '这场播了 ' + mins + ' 分钟' : '直播结束'}`);
      log(`下播 → ${st.liveId}，播了 ${mins} 分钟`);
      active = true;                     // 刚下播 = 刚才还在动，刷新活跃时间
      next.lastKind = 'end';
      next.liveId = '';
      next.liveTitle = '';
      next.liveCtime = 0;
      next.miss = 0;
    }
  }

  /* ② 房间消息（只推她本人） */
  const now = Date.now();
  // 游标为空（第一次跑）或落后太多 ⇒ 只补最近 10 分钟，绝不把整段历史倒进群
  const floor = now - 10 * 60e3;
  const since = Math.max(Number(st.roomT) || 0, floor);
  try {
    const msgs = await collect(since, w);
    if (first) log(`${w.nick}：最近 10 分钟她有 ${msgs.length} 条本人发言`);
    if (msgs.length) {
      const newest = msgs[msgs.length - 1].t;
      if (msgs.length === 1) {
        add('room:' + w.uid + ':' + msgs[0].t, msgs[0].t,
          `【${w.nick}·口袋房间】${bjTime(msgs[0].t)}\n${msgs[0].text}`);
      } else {
        const lines = msgs.map((it) => `${bjTime(it.t, false)}  ${it.text}`).join('\n');
        add('room:' + w.uid + ':' + newest, newest,
          `【${w.nick}·口袋房间】${msgs.length} 条新消息\n${lines}`);
      }
      next.roomT = newest;
      active = true;                       // 有新发言 = 她在线
      next.lastKind = msgs.some((m) => /^\[翻牌\]/.test(m.text)) ? 'flip' : 'msg';
      log(`房间消息 ${msgs.length} 条，最新 ${bjTime(newest)}`);
    } else if (!st.roomT || Number(st.roomT) < floor) {
      /* 游标为空，或者已经落后到 10 分钟窗口之外（含历史脏值：早期测试写进去的 123）
         ⇒ 推到 now。否则游标会永远停在那个旧值，每轮都在重复扫同一个窗口。 */
      next.roomT = now;
    }
  } catch (e) {
    next.err = 'room:' + String(e.message || e).slice(0, 60);
    log(`${w.nick} 查房间消息失败：` + next.err);
  }

  /* ③ 在线状态 —— 只看「最后一次动作」，不猜登录态
     🔴 口袋48 不对外暴露成员登录/在线接口（2026-11-12 确认过），所以「她上线了」只能这么推：
        抓到任何动作（开播 / 下播 / 发消息 / 翻牌）⇒ 在线；
        超过 1 小时没有任何动作 ⇒ 判静默（不是「下线」，措辞不撒谎）。
     🔴 冷启动保护：游标里还没有 actT 时只记录、不推送 ——
        否则每次新 runner 起来都会在群里诈一句「上线了」，而人可能一直都在。
     🔴 静默提示只在白天（北京 08:00 以后）发，半夜不吵人；状态照样更新。 */
  const ONLINE_MS = 60 * 60e3;
  const prevOnline = Number(st.online) === 1;
  if (active) {
    next.actT = now;
    next.online = 1;
    /* 从静默恢复 ⇒ 推一条「上线」。开播/下播本身就带提示，不再重复。 */
    const hasLiveItem = items.some((x) => /^live:/.test(String(x.id)));
    if (!prevOnline && Number(st.actT) && !hasLiveItem) {
      items.unshift({
        id: 'on:' + now,
        t: now,
        text: `💡${bjHMS(now)} ${w.nick} 上线了`,
        who: w.nick,
      });
      log('上线 → 从静默恢复');
    }
  } else if (prevOnline && Number(st.actT) && now - Number(st.actT) > ONLINE_MS) {
    next.online = 0;
    const h = Math.round((now - Number(st.actT)) / 36e5);
    const bjHour = new Date(now + BJ).getUTCHours();
    if (bjHour >= 8) {
      add('off:' + st.actT, now, `${bjHMS(now)} ${w.nick} 静默了（已经 ${h} 小时没动静）`);
      log(`静默 → ${h} 小时无动作`);
    } else {
      log(`静默 → ${h} 小时无动作（夜间，不推送）`);
    }
  }

  if (items.length) delete next.err;
  next.at = Date.now();
  await push(items, next, w);
  return next;
}

/* ---------------- 主循环 ---------------- */

const until = Date.now() + RUN;
log(`启动：盯 ${WATCHES.map((w) => w.nick + '(' + w.uid + ')').join('、')}，`
  + `跑 ${Math.round(RUN / 1000)} 秒，每 ${Math.round(EVERY / 1000)} 秒一次`);

const states = new Map();          // uid -> 游标对象
for (const w of WATCHES) {
  try { states.set(w.uid, await stateGet(w.uid)); } catch (e) {
    states.set(w.uid, { err: 'state:' + String(e.message || e).slice(0, 60) });
    log(`${w.nick} 读游标失败（本轮从头算）：` + e.message);
  }
  log(`${w.nick} 游标 =`, JSON.stringify(states.get(w.uid)));
}

let n = 0;
while (Date.now() < until) {
  n++;
  /* 全站在播列表：一次请求给所有人用 */
  let lives = null;
  try { lives = await getLives(); } catch (e) {
    log('查直播失败：' + String(e.message || e).slice(0, 80));
  }
  for (const w of WATCHES) {
    try {
      const nx = await tickOne(w, states.get(w.uid) || {}, lives, n === 1);
      states.set(w.uid, nx);
    } catch (e) {
      log(`${w.nick} 本轮异常：` + String(e.message || e).slice(0, 120));
      const st = { ...(states.get(w.uid) || {}), at: Date.now(), err: String(e.message || e).slice(0, 60) };
      states.set(w.uid, st);
      try { await push([], st, w); } catch { }
    }
  }
  const left = until - Date.now();
  if (left <= 0) break;
  await sleep(Math.min(EVERY, left));
}
log(`结束，共 ${n} 轮`);
