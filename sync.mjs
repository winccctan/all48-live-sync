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
import { fetchMessagePage, fetchLiveListPage, fetchLiveOne, fetchNewestLiveId } from './lib/api.mjs';
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

async function site(path, init) {
  const res = await fetch(SITE + path, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init && init.headers) },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res;
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
try {
  // record=false ⇒ 返回「直播中」；实测 groupId 会被忽略，一次拿到全站在播
  const r = await fetchLiveListPage({ groupId: 1, next: '0', record: false });
  for (const it of r.list) {
    const u = it.userInfo || {};
    const userId = Number(u.userId) || 0;
    let playStreamPath = '';
    try {
      const one = await fetchLiveOne(it.liveId);
      playStreamPath = one.playStreamPath || '';
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
    });
  }
  log(`在播 ${live.length} 场：` + live.map((x) => `${x.nickname}(${x.liveId})`).join(' / '));
} catch (e) {
  log('拉直播列表失败：' + e.message);
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
     · 每人只对最近 VOD_PLAY 条取播放地址（getLiveOne），更早的只留条目
*/
const VOD_FOLLOW_MAX = Number(process.env.VOD_FOLLOW_MAX || 40);
const VOD_SHARD = Number(process.env.VOD_SHARD || 12);
const VOD_PLAY = Number(process.env.VOD_PLAY || 4);
const VOD_KEEP = Number(process.env.VOD_KEEP || 20);
let newestLiveId = '0';

async function vodFor(uid) {
  try {
    const r = await fetchLiveListPage({ userId: uid, next: newestLiveId, record: true });
    const list = (r.list || []).slice(0, VOD_KEEP);
    if (!list.length) return null;
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      let play = it.playStreamPath || it.streamPath || '';
      if (!play && i < VOD_PLAY) {
        try { play = (await fetchLiveOne(it.liveId)).playStreamPath || ''; } catch (e) { /* 单条失败不影响整份 */ }
      }
      out.push({
        liveId: String(it.liveId),
        title: it.title || '',
        cover: it.coverPath || it.cover || '',
        ctime: Number(it.ctime) || 0,
        play,
      });
    }
    return { uid, list: out };
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

/* ---------- ④ 上报 ---------- */
const payload = { live, msgs };
const size = JSON.stringify(payload).length;

if (DRY) {
  console.log('\n[DRY] 不上报。体积 ' + (size / 1024).toFixed(1) + ' KB');
  console.log('在播:', JSON.stringify(live.map((x) => ({ u: x.userId, n: x.nickname, t: x.title, play: !!x.playStreamPath })), null, 1));
  const sample = Object.entries(msgs).find(([, v]) => v.length);
  if (sample) console.log('发言样例 [' + sample[0] + ']:', JSON.stringify(sample[1].slice(0, 3), null, 1));
  if (vods.length) console.log('录播样例:', JSON.stringify(vods[0].list.slice(0, 3), null, 1));
  process.exit(0);
}

const res = await site('/api/ingest', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
  body: JSON.stringify(payload),
});
const out = await res.json();
log(`上报完成 ${JSON.stringify(out)} · 体积 ${(size / 1024).toFixed(1)}KB · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ---------- ⑥ 录播单独上报（失败不影响发言那一份） ---------- */
if (vods.length) {
  try {
    const r = await site('/api/vod/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify(vods),
    });
    log(`录播上报 ${JSON.stringify(await r.json())}`);
  } catch (e) {
    log('录播上报失败：' + e.message);
  }
}
