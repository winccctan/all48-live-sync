/**
 * 红蓝活动 · 礼物计分抓取（弦月回响）
 *
 * 干什么：把**所有成员房间**里粉丝送的礼物消息捞出来，只留「弦月回响」，
 * 攒一批 POST 到站点 /api/gift/ingest。站点按北京时间自然日分文件落 R2，
 * 再按时间区间聚合成「全团榜 / 各团榜 / 送礼人榜 / 搜名字 / 明细看送礼人 ID」。
 *
 * 🔴 接口选型（这条是整件事的地基，2026-10-24 实测）：
 *     /im/api/v1/team/message/list/homeowner  →  200 条里非房主 0、GIFT_TEXT 0
 *         （只回成员本人的发言，粉丝送礼一条都拿不到 —— 用它就永远是 0 分）
 *     /im/api/v1/team/message/list/all        →  200 条里非房主 157、GIFT_TEXT 9
 *         （房间内所有人的消息都在，送礼人 userId / 昵称 / 礼物名 / 数量齐全）
 *   所以这里必须 scope:'all'。历史发言那条链路（sync.mjs）继续用 homeowner，别串。
 *
 * 🔴 单页上限实测 50 条（传 150 也只给 50），要往回翻必须带 nextTime 翻页。
 *
 * 游标：每人「已经扫到哪一刻」存在站点（GET /api/gift/cursor）。
 *   为什么存站点而不是本地：GitHub Actions 的 runner 每次都是全新的，
 *   本地文件活不过一轮。游标只推进到「这一轮实际扫到的最旧一条」，
 *   这样房间太热闹、一轮没扫完也不会把中间那段永久跳过；重复扫到的由站点去重。
 *
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN / POCKET48_TOKEN / SCRAPE_PROXY  —— 与 sync.mjs 相同
 *   GIFT_NAME     目标礼物名（默认「弦月回响」）
 *   GIFT_IDS      额外的 giftId 白名单（逗号分隔，防改名）
 *   CONC          并发（默认 6）
 *   GIFT_PAGES    每人最多往回翻几页（默认 3，一页 50 条）
 *   MAX_MEMBERS   单轮最多扫多少人（默认 600 = 全员）
 *   DRY=1         只打印不提交
 */
import { fetchMessagePage } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const CONC = Math.max(1, Number(process.env.CONC || 6));
const PAGES = Math.max(1, Number(process.env.GIFT_PAGES || 3));
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 600);
const PAGE_LIMIT = 50;      // 实测上限就是 50，传更大没有意义
const DRY = !!process.env.DRY;
const BATCH = Math.max(200, Number(process.env.GIFT_BATCH || 2000));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
if (!DRY && !INGEST) { console.error('缺少 INGEST_TOKEN'); process.exit(1); }
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

/** 打到站点：超时 + 重试 */
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
      await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

/* ---------- ① 游标 + 目标礼物配置（都存站点） ----------
   🔴 目标礼物名/ID 由站点下发而不是写死在这里：活动打分道具会改名
      （888xxx 那批 2023 年改名前直接叫「0.1分 / 1分 / 9分 / 99分」），
      改一次配置就生效，不用改代码重新推。env 里的值只作为兜底。 */
let cursors = {};
let TARGET = String(process.env.GIFT_NAME || '弦月回响').trim();
let EXTRA_IDS = new Set(String(process.env.GIFT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
try {
  const j = await (await site('/api/gift/cursor', {
    headers: { 'x-ingest-token': INGEST },
  })).json();
  cursors = (j && j.cur) || {};
  if (j && j.cfg) {
    if (j.cfg.name) TARGET = String(j.cfg.name).trim();
    if (Array.isArray(j.cfg.ids) && j.cfg.ids.length) EXTRA_IDS = new Set(j.cfg.ids.map(String));
  }
  log(`游标 ${Object.keys(cursors).length} 人 · 目标礼物「${TARGET}」` +
    (EXTRA_IDS.size ? ' + id 白名单 ' + [...EXTRA_IDS].join(',') : ''));
} catch (e) {
  log('读游标/配置失败（用 env 默认值，本轮多扫一点）：' + String(e.message).slice(0, 90));
}

/** 这条礼物是否计入（名字或 giftId 命中） */
function isTarget(gid, gname) {
  const n = String(gname || '').trim();
  if (n && TARGET && n.indexOf(TARGET) >= 0) return true;
  return EXTRA_IDS.has(String(gid || ''));
}

/** 从一条房间消息里抽礼物；不是礼物返回 null */
function parseGift(m, member) {
  let ext = {};
  try { ext = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : (m.extInfo || {}); } catch (e) { ext = {}; }
  const u = ext.user || {};
  const sid = Number(u.userId) || 0;
  const sn = String(u.nickname || u.nickName || '');
  const t = Number(m.msgTime) || 0;
  if (!sid || !t) return null;

  let ct = {};
  try { ct = typeof m.bodys === 'string' ? JSON.parse(m.bodys) : (m.bodys || {}); } catch (e) { return null; }
  const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
  if (!gi) return null;

  return {
    t,
    mid: Number(member.id),
    sid,
    sn,
    g: String(gi.giftName || ''),
    gid: String(gi.giftId || ''),
    num: Math.max(1, Math.floor(Number(gi.giftNum) || 1)),
  };
}

/* ---------- ② 成员目录（取站点的静态资源，避免再维护一份名单） ---------- */
const catalog = new Map();
try {
  const txt = await (await site('/data/members.js')).text();
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  for (const m of arr) catalog.set(Number(m.id), m);
  log(`成员目录 ${catalog.size} 人`);
} catch (e) {
  log('读成员目录失败：' + e.message);
  process.exit(1);
}

// 只扫「有房间、且不是荣誉毕业生」的人（毕业生房间已凉，白烧代理额度）
let uids = [...catalog.values()]
  .filter((m) => m && m.id && m.srv && m.ch && String(m.tm || '').indexOf('荣誉') < 0)
  .map((m) => Number(m.id));
if (process.env.ONLY_UIDS) {
  const want = new Set(String(process.env.ONLY_UIDS).split(',').map((s) => Number(s.trim())).filter(Boolean));
  uids = uids.filter((u) => want.has(u));
}
if (uids.length > MAX_MEMBERS) uids = uids.slice(0, MAX_MEMBERS);
log(`本轮扫 ${uids.length} 个房间` + (DRY ? '（DRY）' : ''));

/* ---------- ③ 逐房间扫 ---------- */
const items = [];
const stats = {};          // 本轮见到的所有礼物名 → 次数（用于核对目标礼物写法）
const ids = {};            // giftId → 礼物名（用来认出 888xxx 活动道具的真实 id）
const newCur = {};
let okCount = 0, errCount = 0, emptyCount = 0, pageTotal = 0;
let cur = 0;

async function memberWorker() {
  for (;;) {
    const i = cur++;
    if (i >= uids.length) return;
    const uid = uids[i];
    const m = catalog.get(uid);
    const since = Number(cursors[String(uid)]) || 0;
    let next = 0;
    let oldest = Infinity;
    let got = 0;
    try {
      for (let p = 0; p < PAGES; p++) {
        const r = await fetchMessagePage({
          serverId: m.srv, channelId: m.ch, nextTime: next, limit: PAGE_LIMIT, token: TOKEN, scope: 'all',
        });
        const msgs = r.messages;
        if (!msgs.length) break;
        pageTotal++;
        for (const x of msgs) {
          const t = Number(x.msgTime) || 0;
          if (t && t < oldest) oldest = t;
          const g = parseGift(x, m);
          if (!g) continue;
          got++;
          const nm = g.g || ('gid:' + g.gid);
          stats[nm] = (stats[nm] || 0) + 1;
          if (g.gid) ids[g.gid] = g.g;
          if (!isTarget(g.gid, g.g)) continue;
          if (since && g.t <= since) continue;   // 已经上报过
          items.push(g);
        }
        // 已经翻到「上轮扫过的位置」就不用再往前了
        if (since && oldest <= since) break;
        if (!r.nextTime || String(r.nextTime) === '0' || String(r.nextTime) === String(next)) break;
        next = r.nextTime;
      }
      if (!got) emptyCount++;
      else okCount++;
      // 游标只推进到「实际扫到的最旧一条」，房间太吵没扫完也不会把中间那段永久跳过
      if (oldest !== Infinity && oldest > since) newCur[uid] = oldest;
    } catch (e) {
      errCount++;
      log(`  ${m.n || uid} 失败：` + String(e.message).slice(0, 80));
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, uids.length) }, memberWorker));
log(`扫描完成：有礼物 ${okCount} 房间 / 无礼物 ${emptyCount} / 失败 ${errCount} · 翻页 ${pageTotal} 次 · ` +
  `命中目标 ${items.length} 条 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
log('见过的礼物：' + JSON.stringify(Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 25)));
// 6 位 888xxx = 活动打分道具（正常礼物是 18~19 位）。目标礼物如果是活动道具，这里一定能看到它的 id
const actIds = Object.entries(ids).filter(([id]) => /^88\d{4}$/.test(id));
if (actIds.length) log('★ 888xxx 活动道具：' + JSON.stringify(actIds));
if (!stats[TARGET]) log(`⚠️ 本轮没见到「${TARGET}」——若多轮都没见到，去 /api/gift?probe=1 核对名字和 id`);

if (DRY) {
  console.log('\n[DRY] 不上报');
  console.log('目标礼物条数 ' + items.length);
  if (items.length) console.log('样本 ' + JSON.stringify(items.slice(0, 5), null, 1));
  process.exit(0);
}

/* ---------- ④ 上报（分批；游标跟最后一批走） ---------- */
let sent = 0, fail = 0;
const chunks = [];
for (let i = 0; i < items.length; i += BATCH) chunks.push(items.slice(i, i + BATCH));
if (!chunks.length) chunks.push([]);   // 没有礼物也要上报：游标和 stats 得存下来

for (let i = 0; i < chunks.length; i++) {
  const last = i === chunks.length - 1;
  const body = { items: chunks[i] };
  if (last) {
    // 游标整张表跟最后一批走（470 人 ≈ 10KB，一次写完；Worker 侧一次写一个键，不会 470 次写）
    body.cursors = newCur;
    body.stats = stats;
    body.ids = ids;
  }
  try {
    const res = await site('/api/gift/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify(body),
    }, { timeout: 120000, retries: 2 });
    const out = await res.json();
    sent += chunks[i].length;
    log(`上报 ${i + 1}/${chunks.length} 批（${chunks[i].length} 条）→ ${JSON.stringify(out)}`);
  } catch (e) {
    fail += chunks[i].length;
    log(`上报第 ${i + 1} 批失败：` + String(e.message).slice(0, 110));
  }
}
log(`完成：上报 ${sent} 条 / 失败 ${fail} 条 · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (fail && !sent) process.exitCode = 1;
