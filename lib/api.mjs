// 口袋48 API 客户端
// 参考 48tools: packages/48tools/src/utils/snh48.ts 与 packages/48tools/src/services/48/index.ts
import { API_BASE } from './config.mjs';
import { generatePa } from './pa.mjs';

// 代理出口支持（零依赖）：设置 SCRAPE_PROXY（或 HTTPS_PROXY）后，
// 通过 HTTP CONNECT 隧道 + TLS 经代理发出请求。
// 用于「境外本机 + 国内代理」：无论你在哪，都能从大陆 IP 访问口袋48。
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { URL } from 'node:url';

// 支持填**多个**备用代理（逗号分隔）：前一个坏了自动换下一个，全坏才回退直连。
// 例：SCRAPE_PROXY=https://u:p@home-jp.gmdns.net:8443,https://u:p@home-jp2.gmdns.net:8443
const PROXY_LIST = (process.env.SCRAPE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
let PROXY_IDX = 0;   // 当前用第几个

// 代理熔断标志：代理一旦证实不可用（407 要认证 / 401 / 403 / 连不上），
// 本轮后续请求直接走直连，不再每个请求都白等一次代理超时。
// 🔴 为什么必须有这个兜底（2026-09-27 事故）：以前代理挂了就一路失败到底，
//    而口袋接口**直连其实是通的** —— 结果整整 3 个半小时发言没更新，还是站长先发现的。
let PROXY_DEAD = false;

if (PROXY_LIST.length) {
  console.log('[代理] 已启用 ' + PROXY_LIST.length + ' 个（坏一个自动换下一个）：' +
    PROXY_LIST.map((u) => u.replace(/\/\/[^@/]*@/, '//***@')).join(' , '));
}

// 经代理发起一次 HTTPS POST（CONNECT 隧道）
function requestViaProxy(url, { method, headers, body }, proxyUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const proxy = new URL(proxyUrl);
    const hostPort = `${target.hostname}:${target.port || 443}`;
    const connectHeaders = { Host: hostPort };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`;
      connectHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(cred).toString('base64');
    }
    const connectReq = httpsRequest({
      host: proxy.hostname,
      port: Number(proxy.port) || 443,
      method: 'CONNECT',
      path: hostPort,
      headers: connectHeaders,
      rejectUnauthorized: false,
      timeout: 20000
    });
    connectReq.on('timeout', () => { connectReq.destroy(new Error('代理 CONNECT 超时')); });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}`));
        return;
      }
      // 底层 socket 也要设超时：HTTP 的 timeout 选项不覆盖 TLS 握手阶段，
      // 若服务端不回应握手，请求会永久挂起（此前抓取卡死即由此引起）。
      socket.setTimeout(20000, () => socket.destroy(new Error('代理隧道 socket 超时')));
      const tlsSocket = tlsConnect(
        { socket, servername: target.hostname, rejectUnauthorized: false },
        () => {
          const req = httpsRequest(
            {
              createConnection: () => tlsSocket,
              method,
              path: target.pathname + target.search,
              headers: { ...headers, Host: target.hostname },
              timeout: 20000
            },
            (r) => {
              const chunks = [];
              r.on('data', (c) => chunks.push(c));
              r.on('end', () =>
                resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') })
              );
            }
          );
          req.on('timeout', () => { tlsSocket.destroy(new Error('请求超时')); });
          req.on('error', reject);
          if (body) req.write(body);
          req.end();
        }
      );
      tlsSocket.setTimeout(20000, () => tlsSocket.destroy(new Error('TLS 会话超时')));
      tlsSocket.on('timeout', () => tlsSocket.destroy(new Error('TLS 会话超时')));
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

// 构造请求头（与 48tools createHeaders 保持一致）
// 注意：Node 的 fetch 不允许手动设置 Host，URL 已隐含 Host，故省略。
function randomDeviceId() {
  const s = 'QWERTYUIOPASDFGHJKLZXCVBNM1234567890';
  const pick = (n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return `${pick(8)}-${pick(4)}-${pick(4)}-${pick(4)}-${pick(12)}`;
}

function buildAppInfo() {
  return JSON.stringify({
    vendor: 'apple',
    deviceId: randomDeviceId(),
    appVersion: '7.0.4',
    appBuild: '23011601',
    osVersion: '16.3.1',
    osType: 'ios',
    deviceName: 'iPhone XR',
    os: 'ios'
  });
}

const APP_USER_AGENT = 'PocketFans201807/6.0.16 (iPhone; iOS 13.5.1; Scale/2.00)';

async function buildHeaders(token) {
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    appInfo: buildAppInfo(),
    'User-Agent': APP_USER_AGENT,
    'Accept-Language': 'zh-Hans-AW;q=1'
  };
  if (token) headers.token = token;
  // pa 为反爬签名，由 wasm 生成。★ 必须无条件携带：
  // 口袋48 已对「直播 / 公演」这类原先无需登录的接口也开始校验 pa，
  // 只带 appInfo 不带 pa 会被直接打回 403（表现为返回一坨 nginx 403 HTML）。
  headers.pa = generatePa();
  return headers;
}

// 网络抖动重试包装：代理出口偶发 socket hang up / ECONNREFUSED / 超时。
// 长时间补抓（上千页）必须靠它扛住抖动，否则中途一断整批白跑（业务类错误不重试）。
export async function postJson(path, body, { token, retries = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await postJsonOnce(path, body, { token });
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      const retriable = /socket hang up|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|timeout|超时|fetch failed|network|other side closed/i.test(msg);
      if (!retriable || attempt === retries) throw e;
      const wait = Math.min(5000, 700 * (attempt + 1));
      console.warn(`[重试 ${attempt + 1}/${retries}] ${path}：${msg.slice(0, 90)}（${wait}ms 后重试）`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function postJsonOnce(path, body, { token } = {}) {
  const url = API_BASE + path;
  const headers = await buildHeaders(token);
  const payload = JSON.stringify(body);

  // 有代理且代理还活着：走 CONNECT 隧道（坏一个自动换下一个，全坏才直连）
  if (!PROXY_DEAD) {
    while (PROXY_IDX < PROXY_LIST.length) {
      const pu = PROXY_LIST[PROXY_IDX];
      try {
        const res = await requestViaProxy(url, { method: 'POST', headers, body: payload }, pu);
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`请求失败 ${res.status} ${path}: ${res.text.slice(0, 200)}`);
        }
        return JSON.parse(res.text);
      } catch (e) {
        const msg = String((e && e.message) || e);
        // 只有「代理本身坏了」才换下一个；接口层的错误照常抛出，交给上层重试
        if (/CONNECT 失败：HTTP (407|401|403)|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|代理 CONNECT 超时/.test(msg)) {
          console.warn(`[代理失效] ${pu.replace(/\/\/[^@/]*@/, '//***@')} ${msg.slice(0, 60)} ⇒ 换下一个`);
          PROXY_IDX += 1;
          continue;
        }
        throw e;
      }
    }
    PROXY_DEAD = true;
    if (PROXY_LIST.length) console.warn('[代理] 全部不可用 ⇒ 后续请求改走直连');
  }

  // 无代理 / 代理已熔断：直连（原生 fetch）
  const res = await fetch(url, { method: 'POST', headers, body: payload });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`请求失败 ${res.status} ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/* ------------------------- 口袋发言（房间消息） ------------------------- */
// POST /im/api/v1/team/message/list/homeowner
// body: { channelId, serverId, nextTime, limit }
export async function fetchMessagePage({ serverId, channelId, nextTime = 0, limit = 700, token }) {
  if (!token) throw new Error('口袋发言需要 POCKET48_TOKEN');
  const data = await postJson('/im/api/v1/team/message/list/homeowner', {
    channelId,
    serverId,
    nextTime,
    limit
  }, { token });
  const content = data?.content || {};
  return {
    messages: Array.isArray(content.message) ? content.message : [],
    nextTime: content.nextTime ?? 0
  };
}

/* ------------------------- 直播 / 录播（按成员） ------------------------- */
// POST /live/api/v1/live/getLiveList
// body: { debug, next, groupId | userId, record }
//
// ⚠️ 两个必须踩对的坑（否则会退化成「翻全团列表、命中率仅 2%」）：
//   1) **按成员查询时不能带 groupId** —— 同时传 groupId+userId 时服务端按 groupId 返回全团；
//      只传 userId 才是「该成员的全部录播」。（实测：只传 userId → 20/20 条全是她）
//   2) **next 必须非 0** —— next=0 时服务端忽略 userId（与 48tools requestLiveList 的 fix 一致）。
//      故按成员翻页前，先用 fetchNewestLiveId() 取全团最新 liveId 作起点。
export async function fetchLiveListPage({ groupId, userId, next, record }) {
  const body = { debug: true, next: String(next), record: !!record };
  if (userId !== undefined && userId !== null && String(userId) !== '') {
    body.userId = Number(userId); // 按成员查询：只传 userId，切勿带 groupId
  } else {
    body.groupId = groupId;
  }
  const data = await postJson('/live/api/v1/live/getLiveList', body);
  const content = data?.content || {};
  return {
    list: Array.isArray(content.liveList) ? content.liveList : [],
    next: content.next ?? '0'
  };
}

// 取「全团最新一条录播」的 liveId，作为按成员翻页的 next 起点（见上面坑 2）
export async function fetchNewestLiveId({ groupId, record = true } = {}) {
  const { list } = await fetchLiveListPage({ groupId, next: '0', record });
  return list[0]?.liveId || '0';
}

/* ------------------------- 公演（官方公开直播/录播） ------------------------- */
// POST /live/api/v1/live/getOpenLiveList
// body: { debug, groupId, next, record }
export async function fetchOpenLivePage({ groupId, next, record }) {
  const data = await postJson('/live/api/v1/live/getOpenLiveList', {
    debug: false,
    groupId,
    next: Number(next) || 0,
    record: !!record
  });
  const content = data?.content || {};
  return {
    list: Array.isArray(content.liveList) ? content.liveList : [],
    next: content.next ?? '0'
  };
}

/* ------------------------- 播放地址（直播 / 公演详情） ------------------------- */
// 直播播放地址：POST /live/api/v1/live/getLiveOne  -> content.playStreamPath
// 参考 48tools: requestLiveRoomInfo
export async function fetchLiveOne(liveId) {
  const data = await postJson('/live/api/v1/live/getLiveOne', { liveId });
  const content = data?.content || {};
  return {
    playStreamPath: content.playStreamPath || '',
    title: content.title || '',
    ctime: content.ctime || ''
  };
}

// 公演播放地址：POST /live/api/v1/live/getOpenLiveOne -> content.playStreams[].streamPath
// 参考 48tools: requestLiveOne
export async function fetchOpenLiveOne(liveId, token) {
  const data = await postJson('/live/api/v1/live/getOpenLiveOne', { liveId }, { token });
  const content = data?.content || {};
  const streams = Array.isArray(content.playStreams) ? content.playStreams : [];
  const mapped = streams
    .map((s) => ({ name: s.streamName, path: s.streamPath || '' }))
    .filter((s) => s.path);
  // 取「高清」优先，其次任意可用流。
  // 注意：raw 流对象的字段是 `streamPath`（不是 `path`），过去这里写成 `.path` 恒为空 —— 已修。
  const best = mapped.find((s) => /高清|hd|fhd|蓝光|超清/i.test(s.name || '')) || mapped[0];
  return {
    streams: mapped,
    playStreamPath: best ? best.path : '',
    title: content.title || '',
    subTitle: content.subTitle || ''
  };
}

/* ------------------------- 登录（手机号 + 短信验证码，拿 POCKET48_TOKEN） ------------------------- */
// 参考 48tools: packages/48tools/src/services/48/login/index.ts
// 无需 token；短信接口不带 pa，登录接口带 pa。

// 发送短信验证码
// 注意：外国手机号（非 +86）会触发人机验证（SNH48 饭圈知识题），
// 此时接口返回 status=2001 且 message 内含 {question, answer:[{option,value}]}，
// 需把所选选项的 value 作为 answer 一起重发。
// 参考 48tools: services/48/login/index.ts requestSMS({mobile, area, answer})
export async function sendSms(mobile, area = '86', answer) {
  const body = { mobile, area };
  if (answer) body.answer = answer;
  const data = await postJson('/user/api/v1/sms/send2', body);
  if (data?.status !== 200 && data?.success !== true) {
    const err = new Error('短信发送失败：' + JSON.stringify(data).slice(0, 600));
    err.payload = data;
    try {
      const inner = JSON.parse(data?.message || '');
      if (inner && inner.question) err.verification = inner; // {question, answer:[{option,value}]}
    } catch { /* message 不是 JSON，忽略 */ }
    throw err;
  }
  return data;
}

// 验证码登录，返回 { token, ... }（LoginUserInfo）
export async function loginMobileCode(mobile, code) {
  const headers = { ...(await buildHeaders()), pa: generatePa() };
  const url = API_BASE + '/user/api/v1/login/app/mobile/code';
  const payload = JSON.stringify({ mobile, code });

  let res;
  if (PROXY_LIST[PROXY_IDX] && !PROXY_DEAD) {
    res = await requestViaProxy(url, { method: 'POST', headers, body: payload }, PROXY_LIST[PROXY_IDX]);
  } else {
    const r = await fetch(url, { method: 'POST', headers, body: payload });
    res = { status: r.status, text: await r.text() };
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`登录失败 ${res.status}: ${res.text.slice(0, 200)}`);
  }
  const data = JSON.parse(res.text);
  if (!data?.content?.token) {
    throw new Error('登录响应中没有 token：' + JSON.stringify(data).slice(0, 200));
  }
  return data.content; // { token, userId, nickname, ... }
}
