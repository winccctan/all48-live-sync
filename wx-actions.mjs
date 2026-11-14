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
 *    online  1 = 在线（最近 `WX_ONLINE_MS` 分钟内有动作，默认 **5 分钟**），0 = 静默
 *            ⚠️ 这是「动作心跳」推出来的，不是登录态 —— 口袋48 不公开登录接口（HTTP 层没有在线字段）。
 *            站长 2026-11-12 定：**静默 5 分钟就算下线**（`WX_ONLINE_MS` 可调）。
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
/* 🔴 名单的**真源在云端**（Worker KV `wxwatch:main`），这里只留一份 env 兜底。
   2026-11-13 站长：「群里加成员的消息推送，可以在这个后台以及指令加吗」——
   以前加人得改本文件上面的 WATCHES / workflow 里的 WATCHES，再推一次 commit；
   现在站长在 `/admin` 后台或群里发「关注 王语晨」就生效，runner 每轮开跑先整份套用。
   env 的 WATCHES 只在「云端读不到」时兜底（token 失效/GitHub 网络抽风）。 */
const ENV_WATCHES = (() => {
  const raw = String(process.env.WATCHES || '').trim();
  if (raw) {
    try {
      const a = JSON.parse(raw);
      const ok = (Array.isArray(a) ? a : []).map((x) => ({
        uid: String(x.uid || '').trim(),
        nick: String(x.nick || x.name || '').trim(),
        srv: String(x.srv || '').trim(),
        ch: String(x.ch || '').trim(),
      })).filter((x) => x.uid && x.nick);
      if (ok.length) return ok;
      console.warn('WATCHES 里没有一条完整（uid/nick 至少要有），退回单成员');
    } catch (e) { console.warn('WATCHES 不是合法 JSON：' + e.message); }
  }
  return [{ uid: WATCH_UID, nick: NICK, srv: SRV, ch: CH }];
})();
let WATCHES = ENV_WATCHES;

/** 从云端拉播报名单。拿不到（网络/鉴权/空表）就退回 env 兜底，绝不让抓取空转。 */
async function watchLoad() {
  try {
    const r = await fetch(`${WORKER}/api/wxwatch`, {
      headers: { 'x-ingest-token': INGEST }, signal: AbortSignal.timeout(15000),
    });
    const j = await r.json();
    const list = (j && Array.isArray(j.list)) ? j.list : [];
    const ok = list.map((x) => ({
      uid: String((x && x.uid) || '').trim(),
      nick: String((x && x.nick) || '').trim(),
      srv: String((x && x.srv) || '').trim(),
      ch: String((x && x.ch) || '').trim(),
    })).filter((x) => x.uid && x.nick);
    if (!ok.length) { log('云端播报名单是空的 ⇒ 用 env 兜底'); return ENV_WATCHES; }
    log(`云端播报名单 ${ok.length} 人：` + ok.map((x) => x.nick).join('、'));
    return ok;
  } catch (e) {
    log('拉云端播报名单失败，用 env 兜底：' + String((e && e.message) || e).slice(0, 80));
    return ENV_WATCHES;
  }
}

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
/** 在线时长文案（站长样例：`在线时长7分33秒`，用「分」不用「分钟」） */
function fmtDur(sec) {
  const s0 = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s0 / 3600);
  const m = Math.floor((s0 % 3600) / 60);
  const s = s0 % 60;
  if (h) return h + '小时' + (m ? m + '分' : '') + (s ? s + '秒' : '');
  if (m) return m + '分' + (s ? s + '秒' : '');
  return s + '秒';
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
  /* 小房间发言额外带一份给 worker 留档（KV `smj:<uid>`，只给群指令 `xfj?` 用）。
     🔴 不进队列、不进网页：队列是「取件即清空」，事后查不了，所以必须单独留档。 */
  const sm = (who && Array.isArray(who.sm)) ? who.sm : [];
  if (who) delete who.sm;
  if (DRY) {
    for (const it of items) log('[DRY] 会推：' + it.text.replace(/\n/g, ' / '));
    for (const s of sm) log('[DRY] 小房间留档：' + bjTime(s.t) + ' ' + String(s.x).slice(0, 40));
    log('[DRY] state =', JSON.stringify(state));
    return;
  }
  const r = await fetch(`${WORKER}/api/wxq/push`, {
    method: 'POST', headers: HDR,
    body: JSON.stringify({ items, state, u: who && who.uid, who: who && who.nick, sm }),
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
  /* 🔴 图片要发真图（2026-11-12 站长：「图片要展示出来具体的图片」）。
     bodys 里是云信 NOS 直链：{"size":638754,"ext":"jpg","w":3024,"url":"https://kd48-nosdn...","md5":"..."}
     ⇒ 把 url 带出去，桥下载后用 `wx send --image` 真发一张，而不是干巴巴一个 [图片]。 */
  let img = '';
  if (type === 'TEXT') content = String(body || '').trim();
  else if (type === 'IMAGE') {
    content = '[图片]';
    try {
      const b = JSON.parse(body);
      img = String(b.url || b.imageUrl || b.picUrl || '');
    } catch { img = ''; }
  }
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
  return { t: Number(m.msgTime) || 0, text: content, img };
}

/** 取 since 之后本人发的消息（最多往回翻 6 页，避免 runner 时间被吃光）
 *  ch 省略 = 大房间；给了 ch 就拉那个频道（小房间用）。 */
async function collect(since, w, ch) {
  const out = [];
  let nextTime = 0;
  for (let p = 0; p < 6; p++) {
    const r = await fetchMessagePage({ serverId: w.srv, channelId: ch || w.ch, nextTime, limit: 50, token: TOKEN });
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

/* ---------------- 小房间 ----------------
 * 2026-11-14 站长：「机器人可以抓到小房间的发言吗，你用我的账号应该可以看到小房间的消息的」。
 * 口袋48 一个成员的 server 下可以有多个频道：
 *   大房间 = 名册里的 ch（公开，谁都能进）
 *   小房间 = 需要「进过这个房间」的账号才看得到（站长自己的号进了一部分）
 * 频道 id 名册里没有、还会变 ⇒ 每轮向 seine 详情问一次（进程内缓存 30 分钟）。
 * 没权限/没房间 ⇒ 返回空数组，主流程照跑。 */
const smallCache = new Map();          // uid -> { at, list:[{ch,name}] }
async function smallChannels(w) {
  const hit = smallCache.get(w.uid);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.list;
  let list = [];
  try {
    const j = await postJson('/im/api/seine/server/detail', { serverId: Number(w.srv) }, { token: TOKEN, retries: 1 });
    const c = (j && j.content) || {};
    list = (c.channelInfoList || [])
      .map((x) => ({ ch: String(x.channelId || ''), name: String(x.channelName || '') }))
      /* 🔴 站长口径（2026-11-14）：「小房间应该是第二个频道」——
         channelInfoList 第 1 个是大房间（= 名册里的 ch），第 2 个才是小房间。 */
      .filter((x, i) => x.ch && i > 0 && x.ch !== String(w.ch));
  } catch (e) {
    log(`${w.nick} 查小房间失败（本轮只播大房间）：` + String((e && e.message) || e).slice(0, 70));
  }
  smallCache.set(w.uid, { at: Date.now(), list });
  return list;
}

/* ---------------- 一轮（单个成员） ----------------
 * `lives` 由主循环**只取一次**（全站在播列表），几个人共用，省掉 N 次重复请求。
 * 返回下轮游标。文案统一成站长给的样式：`[13:51:07] 王语晨 上线了`。 */

async function tickOne(w, st, lives, first) {
  const items = [];
  /* 小房间发言留档（给群指令 `xfj?` 查）：本轮拉到什么就带上什么，随 push 一起交上去 */
  const smOut = [];
  const next = { ...st };
  /* 「她有没有动作」——本轮只要发现开播/下播/新消息/翻牌就算 true。
     这是「上线」判定的唯一依据（口袋48 不公开登录态，只能看动作）。 */
  let active = false;
  /* 🔴 动作发生的「真实时刻」集合（不是我们轮询到它的时刻）。
     站长 2026-11-12 18:57：`17:55 粗发` + `💡[17:55:38]上线了` 顺序反了，
     别人 bot 给的是 `💡[17:55:02]上线了` —— 上线必须用她真正开口的那一刻，
     而且时间戳要早于/等于消息，桥按 t 排序时才会排在消息前面。 */
  const acts = [];
  const add = (id, t, text, img) => items.push(img
    ? { id, t, text, who: w.nick, img }
    : { id, t, text, who: w.nick });

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
    } else if (cur.liveId !== (st.liveId || '') && coldStart) {
      /* 🔴 2026-11-13 站长：「关注了陈淑钰 在游戏群怎么没有推送」。
         她 20:43 就开播，站长 23 点才关注 ⇒ 抓取端第一次看到她时已经播了 157 分钟，
         按上面的 coldStart 规则整段静默，群里一条都没有，看起来就像关注没生效。
         ⇒ 冷启动不诈「刚开播」，但要补一条「正在播」：新关注的成员在播必须让群里知道，
           否则用户没法区分「她没播」和「推送坏了」。 */
      const mins = Math.max(1, Math.round((startedAgo || 0) / 60000));
      add('live:' + cur.liveId + ':now', Date.now(),
        `【${w.nick}·正在播】${cur.title || '直播中'}\n`
        + `已经播了 ${mins} 分钟\n`
        + `https://h5.48.cn/2017/live/index.html?liveId=${cur.liveId}`);
      log(`首次见到时已在播 ${mins} 分钟 → 推「正在播」（不发假开播）`);
    }
    active = true;                       // 在播 = 她肯定在线
    acts.push(Number(cur.ctime) || Date.now());   // 开播那一刻
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
      acts.push(Date.now());
      next.lastKind = 'end';
      next.liveId = '';
      next.liveTitle = '';
      next.liveCtime = 0;
      next.miss = 0;
    }
  }

  /* ② 房间消息（只推她本人）
     🔴 后台/指令加进来的成员可能还没有房间号（名册里 srv/ch 是 0）——
        这种情况**只播开播/下播**，不要去拉房间（拉必报错，日志会被刷满，还白等超时）。 */
  const now = Date.now();
  // 游标为空（第一次跑）或落后太多 ⇒ 只补最近 10 分钟，绝不把整段历史倒进群
  const floor = now - Math.max(1, Number(process.env.WX_SINCE_MIN) || 10) * 60e3;
  const since = Math.max(Number(st.roomT) || 0, floor);
  if (!w.srv || !w.ch) {
    if (first) log(`${w.nick}：没有房间号（srv/ch），本轮只播开播/下播`);
  } else try {
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
      acts.push(msgs[0].t, newest);        // 第一句（她真正上线的时刻）+ 最后一句
      next.lastKind = msgs.some((m) => /^\[翻牌\]/.test(m.text)) ? 'flip' : 'msg';
      log(`房间消息 ${msgs.length} 条，最新 ${bjTime(newest)}`);
      /* 图片单独成条（text 为空、只带 img）：桥先发上面那条文本，再逐张发真图。
         合进文本里发不出去 —— 微信只认本地文件，URL 贴出来就是一行丑链接。 */
      for (const im of msgs.filter((x) => x.img)) {
        add('roomimg:' + w.uid + ':' + im.t, im.t, '', im.img);
      }
    } else if (!st.roomT || Number(st.roomT) < floor) {
      /* 游标为空，或者已经落后到 10 分钟窗口之外（含历史脏值：早期测试写进去的 123）
         ⇒ 推到 now。否则游标会永远停在那个旧值，每轮都在重复扫同一个窗口。 */
      next.roomT = now;
    }
  } catch (e) {
    next.err = 'room:' + String(e.message || e).slice(0, 60);
    log(`${w.nick} 查房间消息失败：` + next.err);
  }

  /* ②b 小房间（同上逻辑，游标按频道分开存 `sm<ch>`，文案标「·小房间」）。
     能不能看到取决于**这个账号进没进那间房** —— 没进就是 0 条，不报错。 */
  if (w.srv && w.ch) try {
    const scs = await smallChannels(w);
    if (first) log(`${w.nick}：小房间 ${scs.length ? scs.map((x) => x.ch + (x.name ? '〈' + x.name + '〉' : '')).join('、') : '无（账号没进 / 她没有小房间）'}`);
    for (const sc of scs) {
      const key = 'sm' + sc.ch;
      const s0 = Math.max(Number(st[key]) || 0, floor);
      const msgs = await collect(s0, w, sc.ch);
      if (msgs.length) {
        const newest = msgs[msgs.length - 1].t;
        const label = `【${w.nick}·小房间】`;
        if (msgs.length === 1) {
          add('small:' + w.uid + ':' + sc.ch + ':' + msgs[0].t, msgs[0].t,
            `${label}${bjTime(msgs[0].t)}\n${msgs[0].text}`);
        } else {
          const lines = msgs.map((it) => `${bjTime(it.t, false)}  ${it.text}`).join('\n');
          add('small:' + w.uid + ':' + sc.ch + ':' + newest, newest,
            `${label}${msgs.length} 条新消息\n${lines}`);
        }
        next[key] = newest;
        active = true;
        acts.push(msgs[0].t, newest);
        if (!next.lastKind) next.lastKind = /^\[翻牌\]/.test(msgs[0].text) ? 'flip' : 'msg';
        log(`小房间消息 ${msgs.length} 条（${sc.name || sc.ch}），最新 ${bjTime(newest)}`);
        for (const im of msgs.filter((x) => x.img)) {
          add('smallimg:' + w.uid + ':' + sc.ch + ':' + im.t, im.t, '', im.img);
        }
        /* 同一批发给 worker 留档（`xfj?` 查历史用）。带频道号 + 频道名，
           一个成员有两个以上小房间时，回复里能分得清是哪间。 */
        for (const it of msgs) {
          smOut.push({ t: it.t, x: String(it.text || '').slice(0, 300), c: sc.ch, cn: String(sc.name || '').slice(0, 20) });
        }
      } else if (!st[key] || Number(st[key]) < floor) {
        next[key] = now;
      }
    }
  } catch (e) {
    next.err = 'small:' + String(e.message || e).slice(0, 60);
    log(`${w.nick} 查小房间失败：` + next.err);
  }

  /* ③ 上下线 —— 站长口径（2026-11-12 18:5x 最终版）：**静默 5 分钟算下线**。
     口袋48 不公开成员登录态（HTTP 接口没有在线字段，NIM 在线订阅被服务端功能开关挡住），
     只能用「静默时长」近似：静默 < `WX_ONLINE_MS`（默认 5 分钟）= 还在线；超了才算下线。
     （中途试过放宽到 20 分钟，站长要回到 5 分钟，2026-11-12 晚改回。）
     🔴 「下线时刻」不能写判定时刻，要写 `actT + ONLINE_MS`。
        Actions 每 5 分钟才起一个 job，判定往往晚十几分钟才发生，但群里该显示的是
        她真正停下的那一刻（站长给的样例 `13:51:07 上线 → [13:58:40] 下线 / 在线 7分33秒`
        就是 actT + 阈值算出来的），所以 offT 和时长都基于 actT，而不是 now。
     🔴 跨 job 保护：每个 job 的**第一轮不做下线判定**（`first`）——
        上个 job 结束后有一段没人在看的空档，不能拿空档当「她走了」，
        否则每个 job 起头都会诈一句「下线了」。
     🔴 上线冷却 5 分钟（跟着阈值一起收窄）：阈值 5 分钟时，她静默 6 分钟会被判下线、
        再说一句又判上线；冷却比阈值长太多会出现「只报下线不报上线」。
     🔴 太旧的离线（>30 分钟）只记状态不推送；夜间（北京 08:00 前）不推下线，免得吵人。 */
  const ONLINE_MS = Math.max(60e3, Number(process.env.WX_ONLINE_MS) || 5 * 60e3);
  const ON_COOLDOWN_MS = Math.max(60e3, Math.min(ONLINE_MS, 5 * 60e3));
  const prevOnline = Number(st.online) === 1;
  /* 🔴 2026-11-12 修：原来上线判定要求「历史 actT 非空」，但 job 换机器时 actT 可能已被
     下线分支清成 0 / 或从没落地过 ⇒ 群里的「上线了」一条都发不出去（桥的已推记录 0 条 on:）。
     改成「以前见过她任何痕迹就算见过人」，只要状态从 0 翻到 1 就播报。 */
  const everSeen = Number(st.actT) > 0 || Number(st.onT) > 0 || Number(st.roomT) > 0;
  /* 本轮动作的真实时刻（她手机上的那一刻，不是我们轮询到的那一刻）：
     evFirst = 这一轮第一次动 ⇒ 「上线」播报时间用它；
     evLast  = 最后一次动 ⇒ 记进 actT，算下线时刻（actT + 阈值）。 */
  const evFirst = acts.length ? Math.min(...acts, now) : now;   // 夹一下 now：服务端时间偶尔比本地快
  const evLast = acts.length ? Math.min(Math.max(...acts), now) : now;
  if (active) {
    if (!prevOnline) next.onT = evFirst;  // 这一轮才刚上线，开始计时
    next.actT = evLast;
    next.online = 1;
    /* 从静默恢复 ⇒ 推一条「上线」。开播/下播本身就带提示，不再重复。 */
    const hasLiveItem = items.some((x) => /^live:/.test(String(x.id)));
    if (!prevOnline && everSeen && !hasLiveItem) {
      const lastOn = Number(st.onPushT) || 0;
      if (evFirst - lastOn >= ON_COOLDOWN_MS) {
        items.unshift({
          id: 'on:' + evFirst,
          t: evFirst,
          text: `💡${bjHMS(evFirst)}${w.nick} 上线了`,
          who: w.nick,
        });
        next.onPushT = evFirst;
        log(`上线 → ${w.nick} ${bjHMS(evFirst)}（动作时刻，判定延迟 ${Math.round((now - evFirst) / 1000)} 秒）`);
      } else {
        log(`上线（${Math.round((evFirst - lastOn) / 60e3)} 分钟内刚播报过，不刷屏）`);
      }
    }
  } else if (prevOnline && Number(st.actT)
    /* 🔴 2026-11-12：原来第一轮（!first）绝不判下线，可 job 只活 4.5 分钟、
       断档时下一 job 首轮又跳过 ⇒ 某次「20 分钟静默」永远等不到第二轮的判定，
       结果 wx:log 里只有 on、一条 off 都没有。改成：首轮也判，但要多给 10 分钟宽限，
       避免「上个 job 结束 → 本 job 开始」的空档被当成她走了。 */
    && (!first || now - Number(st.actT) > ONLINE_MS + 10 * 60e3)
    && now - Number(st.actT) > ONLINE_MS) {
    next.online = 0;
    const onT = Number(st.onT) || Number(st.actT);
    const offT = Number(st.actT) + ONLINE_MS;   // 她真正停下的时刻
    const dur = Math.max(0, Math.round((offT - onT) / 1000));
    const stale = now - offT > 30 * 60e3;       // 判得太晚（job 断档），只记状态
    const bjHour = new Date(offT + BJ).getUTCHours();
    if (!stale && bjHour >= 8) {
      add('off:' + st.actT, offT, `🕑${bjHMS(offT)}${w.nick} 下线了\n在线时长${fmtDur(dur)}`);
      log(`下线 → 在线 ${fmtDur(dur)}`);
    } else {
      log(`下线（${stale ? '判定太晚' : '夜间'}，不推送）→ 在线 ${fmtDur(dur)}`);
    }
    next.onT = 0;
  }

  if (items.length) delete next.err;
  next.at = Date.now();
  if (smOut.length) w.sm = smOut;
  await push(items, next, w);
  return next;
}

/* ---------------- 主循环 ---------------- */

const until = Date.now() + RUN;
/* 名单每轮都从云端套用（后台/群指令改了，下一轮 job 就生效，不用重新部署） */
WATCHES = await watchLoad();
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
