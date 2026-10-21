/**
 * 48 成员档案 · 实时同步（全员）
 *
 * 跑在 GitHub Actions（海外 IP）—— 但口袋48 的接口按 IP 地域拦（海外一律 403），
 * 所以必须经 SCRAPE_PROXY（国内出口代理）发出请求。站点的 Cloudflare Worker
 * 自己是拉不到的（实测 colo=NRT 时 403），只能靠这里「搬」。
 *
 * 每轮做三件事：
 *   ① 拉全站「正在直播」列表（含每场直播的 m3u8 播放地址）
 *   ② 拉**全部成员**的最新发言（站点是公开的，访客关注各不同，不能只抓关注的人；
 *      关注的人排在最前面先抓，保证他们最快刷新）
 *   ③ POST 回站点的 /api/ingest（带 INGEST_TOKEN）：
 *      · 更新 hot:all 热窗（即时展示用）
 *      · 同时把新发言并进每人的 gap:<uid> 永久存档（去重、无新增不写）
 *
 * 环境变量：
 *   SITE_URL         站点地址（机器访问走 workers.dev，避开 Cloudflare 的 bot 挑战）
 *   INGEST_TOKEN     写入口令（与 Worker 侧 env.INGEST_TOKEN 一致）
 *   POCKET48_TOKEN   口袋48 登录 token（读房间发言必需）
 *   SCRAPE_PROXY     国内出口代理（多个用逗号分隔）
 *   MAX_MEMBERS      单轮最多抓多少人的发言（默认 600，即全员）
 *   ONLY_FOLLOWED=1  只抓关注的人（本地调试用）
 *   DRY=1            只打印不提交（本地调试用）
 */
import { fetchMessagePage, fetchLiveListPage, fetchLiveListPageMsg48, fetchLiveOne, fetchLiveOneMsg48, fetchNewestLiveId, pickPlayable } from './lib/api.mjs';
import { pocketToView, isOwnerMsg } from './lib/view.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 600);
const ONLY_FOLLOWED = !!process.env.ONLY_FOLLOWED;
const DRY = !!process.env.DRY;
const MSG_LIMIT = 50;      // 每人保留多少条最新发言
const FOLLOW_MSG_LIMIT = 50; // 每人从接口取多少条原始消息

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }

// 所有打到站点的请求都带超时 + 重试。
// 🔴 2026-10-21 事故：`/api/ingest` 一次性塞 500 人发言，Worker 逐人 merge gap 写 R2 太慢，
//    undici 默认 headersTimeout（5 分钟）直接把整个进程打崩 —— 在播列表早就抓到了，
//    却因为排在最后一起上报，整轮白跑。⇒ 请求必须有超时，上报必须拆小。
async function site(path, init, { timeout = 90000, retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(SITE + path, {
        ...init,
        signal: AbortSignal.timeout(timeout),
        headers: { 'User-Agent': UA, Accept: 'application/json', ...(init && init.headers) },
      });
      if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i === retries) throw e;
      log(`  ${path} 失败（${String(e.message).slice(0, 70)}），${i + 1}/${retries} 重试…`);
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/** 上报一批（live 只在第一批带；带超时/重试，单批失败不影响其他批） */
async function postIngest(body, timeout = 120000) {
  const res = await site('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
    body: JSON.stringify(body),
  }, { timeout, retries: 2 });
  return res.json();
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();

/* ---------- ① 抓取名单：全员（关注的人排最前） ---------- */
let followed = [];
try {
  const j = await (await site('/api/follow')).json();
  followed = Array.isArray(j.uids) ? j.uids.map(Number).filter(Boolean) : [];
} catch (e) {
  log('读关注名单失败：' + e.message);
}
// 本地调试/指定名单：FORCE_UIDS=89653517,6737
if (process.env.FORCE_UIDS) {
  followed = process.env.FORCE_UIDS.split(',').map((s) => Number(s.trim())).filter(Boolean);
  log('（FORCE_UIDS 覆盖）');
}
log(`关注并集 ${followed.length} 人`);

/* ---------- 成员目录（从站点静态资源取，避免再维护一份） ---------- */
const catalog = new Map();
try {
  const txt = await (await site('/data/members.js')).text();
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  for (const m of arr) catalog.set(Number(m.id), m);
  log(`成员目录 ${catalog.size} 人`);
} catch (e) {
  log('读成员目录失败：' + e.message);
}

// 全员名单：关注的人优先（最快刷新），其余按目录顺序补全
let uids = followed.slice();
if (!ONLY_FOLLOWED) {
  const seen = new Set(uids);
  for (const id of catalog.keys()) {
    if (!seen.has(id)) { seen.add(id); uids.push(id); }
  }
}
if (uids.length > MAX_MEMBERS) uids = uids.slice(0, MAX_MEMBERS);
log(`本轮抓取 ${uids.length} 人` + (ONLY_FOLLOWED ? '（仅关注）' : '（全员）'));

/* ---------- ② 全站正在直播 ---------- */
const live = [];
let streamSample = null;   // 第一场直播的流字段快照，用来排查「到底有没有 HLS」
try {
  // record=false ⇒ 返回「直播中」；实测 groupId 会被忽略，一次拿到全站在播
  const r = await fetchLiveListPage({ groupId: 1, next: '0', record: false });
  for (const it of r.list) {
    const u = it.userInfo || {};
    const userId = Number(u.userId) || 0;
    // 在播常常只给 rtmp://（浏览器放不了），接口还带 hls/flv 等字段 —— 挑一个浏览器能播的
    let playStreamPath = '', rtmpPath = '';
    try {
      const one = await fetchLiveOne(it.liveId);
      playStreamPath = pickPlayable([
        one.hlsStreamPath, one.liveStreamPath, one.streamPath, one.playStreamPath,
        it.playStreamPath, it.hlsStreamPath, it.streamPath,
      ]);
      rtmpPath = one.rtmpPath || (/^rtmp:/i.test(one.playStreamPath || '') ? one.playStreamPath : '');
      if (!streamSample) streamSample = { liveId: String(it.liveId), keys: one.streamKeys, picked: playStreamPath };
    } catch (e) { /* 单场取流失败不影响其他 */ }
    live.push({
      liveId: String(it.liveId),
      userId,
      nickname: u.nickname || u.starName || '',
      title: it.title || '',
      cover: it.coverPath || '',
      ctime: Number(it.ctime) || 0,
      onlineUserNum: Number(it.onlineUserNum) || 0,
      playStreamPath,
      rtmpPath,     // 浏览器放不了，仅作「去 App 看」的兜底标识
    });
  }
  log(`在播 ${live.length} 场：` + live.map((x) => `${x.nickname}(${x.liveId})`).join(' / '));
  log('可播流 ' + live.filter((x) => /^https?:/i.test(x.playStreamPath)).length + '/' + live.length +
    ' · 首场流字段 ' + JSON.stringify(streamSample));
} catch (e) {
  log('拉直播列表失败：' + e.message);
}

/* ---------- ②b 直播「先」落库（关键：别排到最后） ----------
   在播列表只有几十 KB，单独 POST 秒级完成，访客立刻能看到「谁在播」；
   后面的发言/录播哪怕整段崩了，在播状态也已经写进热窗了。
   热窗是合并写入（{live, msgs:{}} 只改 live，不动已有发言）。 */
if (!DRY && live.length) {
  try {
    const out = await postIngest({ live, msgs: {} }, 60000);
    log('直播热窗已更新 ' + JSON.stringify(out));
  } catch (e) {
    log('直播热窗上报失败：' + String(e.message).slice(0, 120));
  }
}

/* ---------- ③ 全员最新发言（并发池，关注的人在最前先抓） ---------- */
const msgs = {};
let okCount = 0, emptyCount = 0, errCount = 0;
let cursor = 0;
const CONC = Number(process.env.CONC || 5);

async function memberWorker() {
  for (;;) {
    const i = cursor++;
    if (i >= uids.length) return;
    const uid = uids[i];
    const m = catalog.get(uid);
    if (!m || !m.ch || !m.srv) { errCount++; continue; }
    try {
      const r = await fetchMessagePage({
        serverId: m.srv, channelId: m.ch, nextTime: 0, limit: FOLLOW_MSG_LIMIT, token: TOKEN,
      });
      const items = r.messages
        .filter((x) => isOwnerMsg(x, uid))
        .map(pocketToView)
        .filter((x) => x.t && (x.x || x.i || x.a || x.v || x.c))
        .sort((a, b) => b.t - a.t)
        .slice(0, MSG_LIMIT);
      if (items.length) { msgs[uid] = items; okCount++; } else emptyCount++;
    } catch (e) {
      errCount++;
      log(`  ${m.n} 抓取失败：` + String(e.message).slice(0, 90));
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, uids.length) }, memberWorker));
log(`发言：成功 ${okCount} 人 / 空 ${emptyCount} 人 / 失败 ${errCount} 人`);

/* ---------- ⑤ 录播（历史回放） ----------
   为什么不在 Worker 侧直接抓：口袋48 按 IP 地域拦，Cloudflare 出口一律 403，
   只有这里（经国内代理）拉得到。抓到后 POST /api/vod/put 存进 R2。
   开销控制：
     · 关注的人每轮必抓（他们最常被点开）
     · 其余成员分片轮转，每轮 VOD_SHARD 人，若干轮覆盖全员
    · 取播放地址时**跳过库里已经有了的场次** —— 每轮真正需要取址的只有新增那几场，
      否则 52 人 × 20 场 × 2.4s 会拖爆 12 分钟的时限
*/
const VOD_FOLLOW_MAX = Number(process.env.VOD_FOLLOW_MAX || 40);
const VOD_SHARD = Number(process.env.VOD_SHARD || 12);
const VOD_PLAY_CONC = Number(process.env.VOD_PLAY_CONC || 5);
const VOD_KEEP = Number(process.env.VOD_KEEP || 20);
let newestLiveId = '0';

async function vodFor(uid) {
  try {
      // 翻页也走 msg48 主通道（海外直连），失败回退官方（官方要走国内代理，容易抖）
      let r;
      try {
        r = await fetchLiveListPageMsg48({ userId: uid, next: newestLiveId, record: true });
      } catch (e) {
        r = await fetchLiveListPage({ userId: uid, next: newestLiveId, record: true });
      }
      const list = (r.list || []).slice(0, VOD_KEEP);
    if (!list.length) return null;
    // 库里已有的播放地址不必再取一遍：先读一次该成员现有回放，建 liveId → play 索引
    const have = new Map();
    try {
      const prev = await (await site('/api/vod?id=' + uid)).json();
      for (const o of (prev && Array.isArray(prev.list) ? prev.list : [])) {
        if (o && o.liveId && o.play) have.set(String(o.liveId), o.play);
      }
    } catch (e) { /* 读不到就当全都没有 */ }

    const out = new Array(list.length);
    let pi = 0;
    async function playWorker() {
      for (;;) {
        const i = pi++;
        if (i >= list.length) return;
        const it = list[i];
        let play = pickPlayable([it.playStreamPath, it.hlsStreamPath, it.streamPath]) || have.get(String(it.liveId)) || '';
        if (!play) {
          // 主通道 msg48（海外直连，实测 10/10 成功、0.5s/条，且不限流）；
          // 取不到才回退官方接口（要走国内代理，代理一抖就整批失败）。
          try {
            const m = await fetchLiveOneMsg48(it.liveId);
            play = pickPlayable([m.playStreamPath, m.hlsStreamPath, m.liveStreamPath, m.streamPath]);
          } catch (e) { /* 回退官方 */ }
          if (!play) {
            try {
              const one = await fetchLiveOne(it.liveId);
              play = pickPlayable([one.playStreamPath, one.hlsStreamPath, one.liveStreamPath, one.streamPath]);
            } catch (e) { /* 单条失败不影响整份 */ }
          }
        }
        out[i] = {
          liveId: String(it.liveId),
          title: it.title || '',
          cover: it.coverPath || it.cover || '',
          ctime: Number(it.ctime) || 0,
          play,
        };
      }
    }
    await Promise.all(Array.from({ length: Math.min(VOD_PLAY_CONC, list.length) }, playWorker));
    return { uid, list: out.filter(Boolean) };
  } catch (e) {
    return null;
  }
}

let vods = [];
try {
  newestLiveId = await fetchNewestLiveId({ groupId: 1, record: true });  // 按成员翻页的 next 起点（不能是 0）
  const sorted = Array.from(catalog.keys()).sort((a, b) => a - b);
  const round = Math.floor(Date.now() / 900000);
  const start = (round * VOD_SHARD) % Math.max(1, sorted.length);
  const shard = sorted.slice(start, start + VOD_SHARD);
  const targets = [];
  const seen = new Set();
  for (const id of followed.slice(0, VOD_FOLLOW_MAX).concat(shard)) {
    if (seen.has(id)) continue;
    seen.add(id); targets.push(id);
  }
  log(`录播：本轮 ${targets.length} 人（关注 ${Math.min(followed.length, VOD_FOLLOW_MAX)} + 分片 ${VOD_SHARD}）`);

  let vc = 0, vodOk = 0;
  const VCONC = Math.max(1, Math.min(Number(process.env.VOD_CONC || 4), 8));
  async function vodWorker() {
    for (;;) {
      const i = vc++;
      if (i >= targets.length) return;
      const r = await vodFor(targets[i]);
      if (r) { vods.push(r); vodOk++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VCONC, targets.length) }, vodWorker));
  log(`录播：有内容 ${vodOk} 人`);
} catch (e) {
  log('录播抓取失败：' + e.message);
}

/* ---------- ④ 上报：分批 ----------
   旧版一次性 POST {live, msgs(500 人)}：Worker 要逐人 merge gap 写 R2，
   实测 5 分钟不回响应头 ⇒ undici HeadersTimeoutError ⇒ 进程直接崩，整轮白丢。
   现在按 INGEST_BATCH（默认 60 人/批）拆开，每批独立超时，某批失败不影响其他批。 */
const totalSize = JSON.stringify({ live, msgs }).length;

if (DRY) {
  console.log('\n[DRY] 不上报。体积 ' + (totalSize / 1024).toFixed(1) + ' KB');
  console.log('在播:', JSON.stringify(live.map((x) => ({ u: x.userId, n: x.nickname, t: x.title, play: !!x.playStreamPath })), null, 1));
  const sample = Object.entries(msgs).find(([, v]) => v.length);
  if (sample) console.log('发言样例 [' + sample[0] + ']:', JSON.stringify(sample[1].slice(0, 3), null, 1));
  if (vods.length) console.log('录播样例:', JSON.stringify(vods[0].list.slice(0, 3), null, 1));
  process.exit(0);
}

/* ---------- ④a 录播先上报（独立键，别被后面大批次拖死） ---------- */
if (vods.length) {
  try {
    const r = await site('/api/vod/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify(vods),
    }, { timeout: 120000, retries: 1 });
    log(`录播上报 ${JSON.stringify(await r.json())}`);
  } catch (e) {
    log('录播上报失败：' + e.message);
  }
}

/* ---------- ④b 发言分批上报 ---------- */
const withMsgs = Object.keys(msgs).filter((u) => Array.isArray(msgs[u]) && msgs[u].length);
const BATCH = Math.max(10, Number(process.env.INGEST_BATCH || 60));
const batches = [];
for (let i = 0; i < withMsgs.length; i += BATCH) batches.push(withMsgs.slice(i, i + BATCH));

let sentOk = 0, sentFail = 0;
for (let i = 0; i < batches.length; i++) {
  const part = {};
  for (const uid of batches[i]) part[uid] = msgs[uid];
  const body = { msgs: part };
  if (i === 0) body.live = live;   // 第一批再带一次在播，确保热窗里是最新的
  try {
    const out = await postIngest(body);
    sentOk += batches[i].length;
    log(`上报 ${i + 1}/${batches.length} 批（${batches[i].length} 人）→ ${JSON.stringify(out)}`);
  } catch (e) {
    sentFail += batches[i].length;
    log(`上报第 ${i + 1} 批失败（${batches[i].length} 人）：` + String(e.message).slice(0, 110));
  }
}
log(`上报完成：成功 ${sentOk} 人 / 失败 ${sentFail} 人 · 体积 ${(totalSize / 1024).toFixed(1)}KB · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 全批失败才让 workflow 变红（部分失败只留日志，避免刷红告警）
if (!batches.length || (sentFail && !sentOk)) process.exitCode = 1;
