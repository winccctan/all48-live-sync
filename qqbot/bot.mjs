/**
 * QQ 群机器人 · OneBot 11（2026-11-12）
 * =====================================================
 * 站长：「微信和 QQ 都要有的，现在主要在用微信」。
 *   微信那条 = 手机 AutoJS 取件（必须有台真机）；
 *   QQ  这条 = 本脚本 + NapCat/Lagrange，**服务器上就能跑，不需要手机**。
 *
 * 数据流（和微信那条共用同一批消息，互不干扰）：
 *   口袋48 → Actions(wx-actions.mjs) → Worker /api/wxq/push
 *        → 双写 wx:q（手机取）与 qq:q（本脚本取）
 *        → 本脚本每 10 秒 GET /api/qqq 取件 → OneBot send_group_msg → QQ 群
 *
 *   群消息 → OneBot 事件 → 本脚本认 `LG?名字` → GET /api/cmd
 *        → **口径全部在 all48-lv**（和微信群指令同一个接口，改文案不用动这里）
 *
 * 为什么不直接装 qqtools：它抓取用的同样是云信 NIM 直连（sdk/NimChatroomSocket.ts），
 * 我们的 nim-client 已经跑通了，数据层比它全；它 QQ 侧也是 OneBot（GoCQHttp 适配器）。
 * ⇒ 只缺「发」这一层，200 行足够，不必再引一整个 Electron 应用。
 *
 * 前置：
 *   1) 一台常开机器（家里旧笔记本 / NAS / VPS 都行，Linux/macOS/Windows 均可）
 *   2) NapCat（推荐，基于官方 NTQQ 客户端，无头可跑）或 Lagrange.OneBot
 *      开一个 OneBot 11 WebSocket 服务，默认 ws://127.0.0.1:3001
 *   3) 一个 QQ 小号（新号先正常登录几天再挂机器人，别一上来就发消息）
 *   4) 一个 QQ 群，把小号拉进去
 *
 * 运行：
 *   export WX_QUEUE_TOKEN=...      # 和手机同一个 token
 *   export ONEBOT_WS=ws://127.0.0.1:3001
 *   export QQ_GROUPS=123456789     # 多个用逗号分隔
 *   node qqbot/bot.mjs             # 首次接请先加 --drain 扔掉历史积压
 */
const WORKER = (process.env.WORKER_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const KEY = String(process.env.WX_QUEUE_TOKEN || '');
const ONEBOT_WS = String(process.env.ONEBOT_WS || 'ws://127.0.0.1:3001');
const ONEBOT_TOKEN = String(process.env.ONEBOT_TOKEN || '');
const GROUPS = String(process.env.QQ_GROUPS || '')
  .split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^\d{5,}$/.test(s));
const POLL = Math.max(3000, Number(process.env.POLL || 10000));
const DRAIN = process.argv.includes('--drain');

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) { console.error('缺 WX_QUEUE_TOKEN'); process.exit(1); }
if (!GROUPS.length) { console.error('缺 QQ_GROUPS（填群号，逗号分隔）'); process.exit(1); }

/* ---------------- OneBot 连接 ---------------- */

let sock = null;
let seq = 0;
let alive = false;
const pending = new Map();

function call(action, params, timeout = 15000) {
  return new Promise((resolve, reject) => {
    if (!sock || !alive) return reject(new Error('OneBot 未连接'));
    const echo = 'e' + (++seq);
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error('调用超时 ' + action)); }, timeout);
    pending.set(echo, {
      res: (v) => { clearTimeout(timer); resolve(v); },
      rej: (e) => { clearTimeout(timer); reject(e); },
    });
    try { sock.send(JSON.stringify({ action, params, echo })); }
    catch (e) { clearTimeout(timer); pending.delete(echo); reject(e); }
  });
}

async function sendGroup(gid, text) {
  /* 纯文本即可；QQ 侧不支持我们文案里的任何富文本约定，原样发反而不会丢格式 */
  const r = await call('send_group_msg', { group_id: Number(gid), message: String(text).slice(0, 2000) });
  return r;
}

let reconnects = 0;
let retryTimer = null;

/** 🔴 重连必须挂在 error 上，不能只挂 close（2026-11-12 空跑实测）：
 *  目标端口没人听时，Node 的 WebSocket 只发 `error`，`close` 一直不来 ⇒
 *  只挂 close 的话，NapCat 晚起一步，bot 就永远静止在那里，日志什么都不打。 */
function scheduleReconnect(reason, s) {
  if (sock === s) { sock = null; alive = false; }
  for (const [, p] of pending) p.rej(new Error('连接已断开'));
  pending.clear();
  if (retryTimer) return;                         // error 和 close 可能前后脚来，只排一次
  reconnects++;
  const wait = Math.min(30000, 2000 * reconnects);
  log(`OneBot ${reason}，${Math.round(wait / 1000)} 秒后重连（第 ${reconnects} 次）`);
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, wait);
}

function connect() {
  const url = ONEBOT_TOKEN
    ? ONEBOT_WS + (ONEBOT_WS.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(ONEBOT_TOKEN)
    : ONEBOT_WS;
  let s;
  try { s = new WebSocket(url); }
  catch (e) { log('建连失败：' + e.message); scheduleReconnect('建连异常', null); return; }

  s.addEventListener('open', () => {
    clearTimeout(openTimer);
    sock = s; alive = true; reconnects = 0;
    log(`OneBot 已连上 ${ONEBOT_WS} · 群 ${GROUPS.join(',')}`);
  });
  /* 连接也可能「既不 open 也不 error」（TCP 半开、NAT 掉表）⇒ 10 秒兜底 */
  const openTimer = setTimeout(() => {
    if (sock === s) return;
    try { s.close(); } catch { }
    scheduleReconnect('10 秒未连上', s);
  }, 10000);
  s.addEventListener('message', (ev) => {
    let d;
    try { d = JSON.parse(String(ev.data)); } catch { return; }
    if (d && d.echo && pending.has(d.echo)) {
      const p = pending.get(d.echo); pending.delete(d.echo);
      const ok = d.retcode === 0 || d.status === 'ok' || d.status === 'async';
      ok ? p.res(d) : p.rej(new Error(`retcode ${d.retcode} ${d.message || d.wording || ''}`));
      return;
    }
    handleEvent(d).catch((e) => log('事件异常：' + (e && e.message)));
  });
  s.addEventListener('close', () => scheduleReconnect('断开', s));
  s.addEventListener('error', (ev) => {
    scheduleReconnect('连不上 ' + ONEBOT_WS + ((ev && ev.message) ? '（' + ev.message + '）' : ''), s);
  });
}

/* ---------------- 群指令 ---------------- */

/* 最近回过的 message_id，防 NapCat 断线重连时把同一条事件再推一次 */
const replied = new Map();
function seenBefore(id) {
  const k = String(id || '');
  if (!k) return false;
  const now = Date.now();
  for (const [kk, t] of replied) if (now - t > 120000) replied.delete(kk);
  if (replied.has(k)) return true;
  replied.set(k, now);
  return false;
}

/** 只认 `LG?名字` / `lg 名字` / `鸡腿?名字` / `rb?名字`，且必须带名字；其余聊天一概不理。
 *  🔴 三个坑（2026-11-12 实测）：
 *    1) 全角 `ＬＧ？` —— 中文输入法下极常见，不归一化就整条静默（lv 侧虽然也会归一，
 *       但本脚本得先认出来才轮得到转发）；
 *    2) `lgtm` / `lgbt` 这类英文词 —— 无分隔符时只接受**以中文起头**的名字，
 *       否则 `lg` + `tm` 会被当成查「tm」，群里回一句「没找到」很难看；
 *    3) 只发一个 `lg` —— 让它走一遍，由 lv 回「用法：LG?成员名」。
 *  `rb?…` 查红蓝票数（成员 / 队伍 / 团），由 all48-worker 本地算，不转发 lv。 */
function cmdOf(d) {
  let raw = String(d.raw_message || '');
  if (!raw && Array.isArray(d.message)) {
    raw = d.message.map((x) => (x && x.type === 'text' ? String((x.data || {}).text || '') : '')).join('');
  }
  const s = raw.replace(/\[CQ:[^\]]*\]/g, ' ')      // @、回复引用、图片等 CQ 码全部剔掉
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角→半角
    .replace(/[\u2005\u00a0]/g, ' ')
    .trim();

  let m = /^rb\s*[?？:：,，.。、!！]?\s*([\s\S]*)$/i.exec(s);
  if (m) return { kind: 'rb', name: String(m[1] || '').trim().slice(0, 60) || ' ' };
  m = /^(?:lg|鸡腿)\s*[?？:：,，.。、!！]\s*([\s\S]*)$/i.exec(s);
  if (m) {
    const v = String(m[1] || '').trim();
    return { kind: 'lg', name: (v || ' ').slice(0, 60) };   // `lg?` 光问号也给 lv 一次，让它回用法
  }
  m = /^(?:lg|鸡腿)\s*([\u4e00-\u9fa5·][\s\S]*)$/i.exec(s);
  if (m) return { kind: 'lg', name: String(m[1] || '').trim().slice(0, 60) };
  if (/^(?:lg|鸡腿)$/i.test(s)) return { kind: 'lg', name: ' ' };   // 只有指令没有名字 → 让 lv 回用法
  return null;
}

async function handleEvent(d) {
  if (!d || d.post_type !== 'message' || d.message_type !== 'group') return;
  const gid = String(d.group_id || '');
  if (!GROUPS.includes(gid)) return;
  if (String(d.user_id) === String(d.self_id)) return;

  const c = cmdOf(d);
  if (!c) return;
  if (seenBefore(d.message_id)) return;

  const u = new URL(WORKER + '/api/cmd');
  u.searchParams.set('k', KEY);
  u.searchParams.set('q', c.kind + '?' + c.name);
  let j = null;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    j = await r.json();
  } catch (e) {
    log('指令请求失败：' + (e && e.message));
    return;
  }
  if (!j || !j.ok || !j.reply) { log(`指令无结果 ${c.kind}:${c.name} → ${JSON.stringify(j).slice(0, 120)}`); return; }
  try {
    await sendGroup(gid, j.reply);
    log(`已回群 ${gid}：${c.kind}:${c.name}`);
  } catch (e) {
    log('回群失败：' + (e && e.message));
  }
}

/* ---------------- 队列拉取 ---------------- */

let lastBeat = '';
async function beat() {
  lastBeat = `qq-g${GROUPS.length}` + (alive ? '' : '-ws0');
}

async function pollOnce() {
  /* 🔴 没连上 OneBot 就不取件 —— 取走即清空，发不出去就等于把消息吃掉。
     留在队列里（上限 40 条）比丢掉好，断线恢复后还能补上最近几条。 */
  if (!alive) return;

  const u = new URL(WORKER + '/api/qqq');
  u.searchParams.set('k', KEY);
  await beat();
  u.searchParams.set('s', lastBeat);

  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) { log('取件 HTTP ' + r.status); return; }
  const j = await r.json();
  const items = (j && Array.isArray(j.items)) ? j.items : [];
  if (!items.length) return;

  log(`取到 ${items.length} 条`);
  for (const it of items) {
    const text = String((it && it.text) || '');
    if (!text) continue;
    for (const g of GROUPS) {
      try { await sendGroup(g, text); }
      catch (e) { log(`发 ${g} 失败：${(e && e.message)}`); }
      await sleep(300);              // 两条之间停一下，别把风控惹毛
    }
  }
}

async function drainOnce() {
  const u = new URL(WORKER + '/api/qqq');
  u.searchParams.set('k', KEY);
  u.searchParams.set('drain', '1');
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  log(`已丢弃历史积压 ${(j && j.drained) || 0} 条`);
}

/* ---------------- 主流程 ---------------- */

log(`启动：worker=${WORKER} onebot=${ONEBOT_WS} 群=${GROUPS.join(',')}`);
if (DRAIN) await drainOnce().catch((e) => log('丢弃失败：' + e.message));

connect();

while (true) {
  try { await pollOnce(); }
  catch (e) { log('取件异常：' + (e && e.message)); }
  await sleep(POLL);
}
