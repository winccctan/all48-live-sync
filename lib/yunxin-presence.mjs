/**
 * 云信 IM 服务端「在线状态订阅」客户端（eventType=1）
 *
 * 官方文档（2026-11-13 逐条核对过，不是凭记忆写的）：
 *   https://doc.yunxin.163.com/messaging/server-apis/jk3MzY2MTI?platform=server   （鉴权 / CheckSum）
 *   https://doc.yunxin.163.com/messaging/server-apis/jc5NDQwODk?platform=server   （add/query/delete/batchdel）
 *   https://doc.yunxin.163.com/messaging-enhanced/guide/TE2ODU3NjM?platform=web   （事件值 1/2/3、推送可达、单向订阅）
 *   https://faq.yunxin.163.com/kb/legacy/legacy.html                              （KB0015：三条独立路径）
 *
 * 🔴 官方口径：拿到「用户登录登出信息」有三条【并列、互相独立】的路径，别混成一套：
 *   ① 在线状态事件订阅 —— 服务端 API 发起订阅，事件由云信推给【订阅人的客户端 SDK】
 *      （onPushEvents / msgEvents）。本模块实现的是这一条。
 *   ② 登录登出消息抄送 —— 云信 POST 到【开发者服务器】配好的 URL（LOGIN/LOGOUT 抄送），
 *      也是 Webhook，但它不是 ① 的配套，是另一条独立实现；且抄送可能乱序/丢失/不成对，
 *      要按 timestamp 维护状态。本模块【未实现】，需先拿到真实抄送报文样本再写接收器。
 *   ③ history/queryUserEvents.action —— 开发者主动查登录登出记录，查不到开通前的历史。
 *   ⇒ ②/③ 只有应用所有者能配；但 ① 的【发起订阅】有两条入口：服务端 API（要 AppSecret）
 *      或 **客户端 SDK 的 nim.event.subscribeEvent（只要登录态，不要 AppSecret）**——
 *      2026-11-13 查官方 Web 文档确认。所以「粉丝号一定拿不到」是过度结论，已修正。
 *
 * 🔴 本路径 4 个前置条件，缺任何一个都跑不起来（本模块只如实报错，绝不猜测、绝不伪造）：
 *   ① YUNXIN_APP_KEY + YUNXIN_APP_SECRET —— 必须是【该云信应用所有者】的服务端凭据。
 *      AppSecret 只能放服务端，不能进前端、不能进 public 仓库。
 *   ② 控制台「在线状态订阅」已开通。未开通调用返回非 200。
 *      🔴🔴 2026-11-13 终局实测（SDK 源码 + 正确组包 + 对照命令，证据见
 *      output/fp-archive-2025/presence-probe.md）：
 *        · 官方 Web SDK 9.21.18 解出 subscribeEvent = **14/3**（不是 14/1），
 *          body = Property(msgEventSubscribe{1:type,2:ttl,3:sync}) + StrArray(accounts)，
 *          编码与 qchat.cjs 的 encodeProperties 完全一致。
 *        · 按正确格式发 14/3 / 14/6 / 14/7 到 NIM 层与 QChat 层 ⇒ **全部 403 + 空 body**。
 *        · 同一条连接上 6/23 getServerTime、6/1 getSimpleNosToken、24/1 全 **200**；
 *          不存在的命令号 14/99、6/99 是**超时无回执**（不是 403）。
 *        ⇒ 服务端认识 14/* 但主动拒绝，且不是 body 格式问题；官方 SDK 9.x 用完整登录包
 *          走 2/3 也被回 403「非法操作或没有权限」。
 *      ⇒ **结论：该 AppKey 未对粉丝号开放 14 事件服务（或客户端类型白名单）。**
 *        第三方账号拿不到实时登录/登出事件流；「像 xox48 那样全自动全程记录」不能走这条路。
 *        脚本 nim-client/presence-probe.mjs 只作取证，不要反复登录（出现过登录后被关连接）。
 *   ③ 成员真实 NIM accid 列表（publisherAccids）。公开 Pocket48 HTTP 只给口袋 uid，
 *      需从 QChat 长连接 fromAccount 采集，不能拿 member_id / server_id 猜。
 *   ④ YUNXIN_SUB_ACCID 订阅人必须【保持一个 IM SDK 在线连接】。官方：订阅人在线时才收得到事件；
 *      订阅人登录时被订阅者在线会补一条在线回调，离线者收不到，建议应用层初始全置离线。
 *      ✅ 2026-11-13 探针修正：nim-client/qchat.cjs 的 NimCommonlinkQChatClient 本来就会
 *      先建一条 **NIM 层 2/2 登录连接**（`client.nimSession`），只是目前仅用它取 QChat 地址。
 *      可以直接在这条连接上 `request(14, cmd, body)`，**不用另起进程/另起连接**；
 *      但要挂到 nimSession 上，挂 qchatSession 收不到 14/*。
 *
 * 🔴 事件值由云信服务器托管，不是客户端发布：1=登录 / 2=登出 / 3=断开连接。
 *    App 被清理但厂商推送可达时默认不触发断开事件（控制台可改），所以「在线」会偏长。
 *    订阅有效期 60~2592000 秒（30 天），过期要续订；每个订阅人最多 3000 个，单次最多 100 个；
 *    订阅是单向的，且 IM 好友关系与在线状态是两套功能，加好友不会自动可见。
 *
 * 🔴 参数以官方为准：add.action 的 Body 只有 accid / eventType / publisherAccids / ttl，
 *    【没有 time 参数】——时间戳只走 Header 的 CurTime。取消/查询路径是 delete.action / query.action
 *    （不是 del.action / get.action），清空是 batchdel.action。
 */
import { createHash, randomBytes } from 'node:crypto';

const PRIMARY = 'https://api.yunxinapi.com';
const BACKUP = 'https://api-cn-bak.yunxinapi.com';
const PREFIX = '/nimserver/event/subscribe';
export const MAX_PUBLISHERS_PER_CALL = 100;
export const MAX_TTL = 2592000; // 30 天

/** 云信内置在线状态事件值 */
export const EVENT_VALUE = Object.freeze({ 1: '登录', 2: '登出', 3: '断开连接' });

export function configFromEnv(env = process.env) {
  return {
    appKey: String(env.YUNXIN_APP_KEY || '').trim(),
    appSecret: String(env.YUNXIN_APP_SECRET || '').trim(),
    subAccid: String(env.YUNXIN_SUB_ACCID || '').trim(),
  };
}

/** 只做本地自检，不联网。给 --check 用。 */
export function checkConfig(env = process.env) {
  const c = configFromEnv(env);
  const missing = [];
  if (!c.appKey) missing.push('YUNXIN_APP_KEY');
  if (!c.appSecret) missing.push('YUNXIN_APP_SECRET');
  if (!c.subAccid) missing.push('YUNXIN_SUB_ACCID');
  return {
    ok: missing.length === 0,
    missing,
    hasAppKey: !!c.appKey,
    hasAppSecret: !!c.appSecret,
    hasSubAccid: !!c.subAccid,
  };
}

/**
 * 完整门槛清单（只做本地判定，不联网、不打印任何值）。
 * Credentials 能自动查；其余三条属于「应用所有者权限 / 外部资料」，只能如实标注为待确认。
 * @returns {{ok:boolean, items:{key:string, state:'ok'|'missing'|'unknown', note:string}[]}}
 */
export function prerequisites(env = process.env) {
  const s = checkConfig(env);
  const items = [
    {
      key: '服务端凭据',
      state: s.hasAppKey && s.hasAppSecret ? 'ok' : 'missing',
      note: s.hasAppKey && s.hasAppSecret ? 'AppKey/AppSecret 已配置' : `缺 ${s.missing.filter((x) => x !== 'YUNXIN_SUB_ACCID').join(', ') || '—'}（须为该应用所有者持有）`,
    },
    { key: '控制台开关', state: 'unknown', note: '「在线状态订阅」需应用管理员在控制台开通，本地无法判定' },
    { key: '成员 NIM accid', state: 'unknown', note: '公开接口只给口袋 uid；需从 QChat fromAccount 采集，不能用 member_id 猜' },
    {
      key: '订阅人 IM 在线连接',
      state: s.hasSubAccid ? 'unknown' : 'missing',
      note: s.hasSubAccid
        ? 'accid 已配置，但必须另起 IM SDK 在线连接；现有 QChat(24/*) 连接不算'
        : '缺 YUNXIN_SUB_ACCID',
    },
  ];
  return { ok: items.every((x) => x.state === 'ok'), items };
}

function assertConfig(env) {
  const c = configFromEnv(env);
  const s = checkConfig(env);
  if (!s.ok) {
    throw new Error(
      `缺少云信服务端配置：${s.missing.join(', ')}。\n` +
      `这些必须是该云信应用所有者合法持有的凭据，本模块不会尝试获取、逆向或伪造。\n` +
      `参考 presence.env.example。\n` +
      `另注意：凭据齐备也只是 4 个门槛之一，见 prerequisites()。`
    );
  }
  return c;
}

/** CheckSum = SHA1(AppSecret + Nonce + CurTime)，CurTime 为 UTC 秒，5 分钟内有效 */
function authHeaders(c) {
  const nonce = randomBytes(16).toString('hex');
  const curTime = String(Math.floor(Date.now() / 1000));
  const checkSum = createHash('sha1').update(c.appSecret + nonce + curTime).digest('hex');
  return {
    AppKey: c.appKey,
    Nonce: nonce,
    CurTime: curTime,
    CheckSum: checkSum,
    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
  };
}

function toForm(body) {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    f.set(k, typeof v === 'string' ? v : String(v));
  }
  return f;
}

/**
 * 调一个服务端 action。主域名失败自动切备用域名。
 * 返回解析后的 JSON；code !== 200 时抛带 code 的错误。
 */
export async function call(action, body = {}, opts = {}) {
  const c = assertConfig(opts.env);
  const form = toForm(body);
  const hosts = opts.hosts || [PRIMARY, BACKUP];
  let lastErr;
  for (const host of hosts) {
    try {
      const r = await fetch(`${host}${PREFIX}/${action}.action`, {
        method: 'POST',
        headers: authHeaders(c),
        body: form,
        signal: AbortSignal.timeout(Number(opts.timeoutMs) || 15000),
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`非 JSON 响应(HTTP ${r.status}): ${text.slice(0, 160)}`); }
      if (j.code !== 200) {
        const hint = j.code === 414
          ? 'CheckSum 校验失败：检查 AppSecret / 服务器时间是否 NTP 同步'
          : '检查：① AppKey/AppSecret 是否属于该应用 ② 控制台「在线状态订阅」是否已开通 ③ accid 是否存在';
        throw new Error(`云信 ${action} 返回 code=${j.code}（${j.desc || ''}）— ${hint}`);
      }
      return j;
    } catch (e) {
      lastErr = e;
      // 业务错误码不用换域名重试，只有网络错误才切备用
      if (String(e.message).includes('返回 code=') || String(e.message).includes('非 JSON')) throw e;
    }
  }
  throw lastErr || new Error(`云信 ${action} 调用失败`);
}

/** 把 accid 列表按 100 分组 —— 服务端单次上限 */
function chunks(arr, n = MAX_PUBLISHERS_PER_CALL) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * 订阅成员在线状态事件。
 * @param {string[]} publisherAccids 成员真实 NIM accid（不是口袋 uid）
 * @param {number} ttl 有效期秒，60~2592000
 * @returns {{code:number, failedAccid:string[], batches:number}}
 */
export async function subscribe(publisherAccids, { ttl = MAX_TTL, env, ...rest } = {}) {
  const c = assertConfig(env);
  const ids = [...new Set((publisherAccids || []).map(String).filter(Boolean))];
  if (!ids.length) throw new Error('subscribe: publisherAccids 为空');
  if (ttl < 60 || ttl > MAX_TTL) throw new Error(`ttl 必须在 60~${MAX_TTL} 秒`);
  const failed = [];
  let batches = 0;
  for (const group of chunks(ids)) {
    const j = await call('add', {
      accid: c.subAccid,
      eventType: 1,
      publisherAccids: JSON.stringify(group),
      ttl: String(ttl),
    }, { env, ...rest });
    batches++;
    if (Array.isArray(j.failedAccid)) failed.push(...j.failedAccid);
  }
  return { code: 200, failedAccid: failed, batches };
}

/** 查询有效订阅关系（单次最多 100 个 accid） */
export async function query(publisherAccids, opts = {}) {
  const c = assertConfig(opts.env);
  const ids = [...new Set((publisherAccids || []).map(String).filter(Boolean))];
  const all = [];
  for (const group of chunks(ids)) {
    const j = await call('query', {
      accid: c.subAccid,
      eventType: 1,
      publisherAccids: JSON.stringify(group),
    }, opts);
    if (Array.isArray(j.subscribes)) all.push(...j.subscribes);
  }
  return all;
}

/** 取消指定订阅 */
export async function unsubscribe(publisherAccids, opts = {}) {
  const c = assertConfig(opts.env);
  const ids = [...new Set((publisherAccids || []).map(String).filter(Boolean))];
  const failed = [];
  for (const group of chunks(ids)) {
    const j = await call('delete', {
      accid: c.subAccid, eventType: 1, publisherAccids: JSON.stringify(group),
    }, opts);
    if (Array.isArray(j.failedAccid)) failed.push(...j.failedAccid);
  }
  return { code: 200, failedAccid: failed };
}

/** 取消订阅人全部 type=1 订阅 */
export async function clearAll(opts = {}) {
  const c = assertConfig(opts.env);
  return call('batchdel', { accid: c.subAccid, eventType: 1 }, opts);
}

/** 续订：直接按 30 天重新 add 一遍（同 accid 重复订阅会覆盖有效期） */
export async function renew(publisherAccids, opts = {}) {
  return subscribe(publisherAccids, { ttl: MAX_TTL, ...opts });
}

/**
 * 挂到【订阅人 IM SDK 在线连接】上收在线事件推送（官方：事件回调走客户端 SDK，不是 Webhook）。
 *
 * 用法（不改 qchat.cjs 原文件，使用时挂即可）：
 *   const stop = attachToSession(session, (evt) => presenceLog.ingest(evt));
 *
 * 事件包是云信 NIM 层 eventService 的推送，serviceId=14。
 * 具体 commandId / Property 编码在「在线状态订阅」功能开通后按抓包确认，
 * 这里只做：① 保存原 onPacket ② 过滤 serviceId ③ 把原始包交给 decode 回调。
 *
 * 🔴 两个「静默无事件」都属预期，别当 bug 修：
 *    ① 控制台没开通 / 没成功订阅过任何 publisherAccids → 服务端根本不推；
 *    ② 订阅人自己不在线 → 官方明确「A 在线时 B 上线才会被监听到」。
 * 🔴 必须挂对层：14/* 走 **NIM 层会话**（`client.nimSession`），不是 QChat 层会话。
 *    NimCommonlinkQChatClient 已经建好这条连接，直接传进去即可，不用另起连接。
 *
 * @param {{onPacket?:Function}} session 已登录的 CommonlinkSession
 * @param {(packet:any)=>void} onRawPacket
 * @returns {()=>void} 取消挂载
 */
export function attachToSession(session, onRawPacket) {
  if (!session || typeof session !== 'object') throw new Error('attachToSession: 需要已登录的 session');
  const prev = typeof session.onPacket === 'function' ? session.onPacket : null;
  session.onPacket = (pkt) => {
    try {
      if (pkt && Number(pkt.serviceId) === 14) onRawPacket(pkt);
    } catch (e) {
      console.error('[presence] onPacket hook error:', e.message);
    }
    if (prev) prev(pkt);
  };
  return () => { session.onPacket = prev || undefined; };
}
