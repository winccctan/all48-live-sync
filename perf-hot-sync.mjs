#!/usr/bin/env node
/**
 * perf-hot-sync.mjs —— 用**官方**公演鸡腿榜实时校准我们的公演榜
 *
 * 为什么有它（站长 2026-10-25：「不允许丢数据，公演鸡腿要当比赛依据」）：
 *   公演礼物只有 48fan 弹幕流一个来源，没有回放、IM 也进不去 ⇒ 流一断就永久少分。
 *   但官方 web 站（live.48.cn）有公开接口，给的是**每人鸡腿**：
 *     GET  /Index/inlive/id/<数字id>      → 隐藏域 #vedio_id(19位liveId) + #param(token)
 *     POST /Index/ajax_getmemberhot/      → {status:"200",desc:[{hot,rank,memberId,memberName}]}
 *   hot 就是官方鸡腿。拿它对账，差多少补多少 ⇒ 榜面数字永远等于官方。
 *
 * 铁律：
 *   · 只增不删（官方 > 我们才补；官方少了不动，对方也会少算）
 *   · 补账行 g='补账'、sn='补账'（不污染送礼人榜，但要进礼物构成）
 *   · token 绑定场次，必须逐场从页面上取；数字 id ≠ liveId，靠扫描比对 #vedio_id 找
 *
 * 用法：
 *   DRY=1 node perf-hot-sync.mjs            # 只对照，不写
 *   LV_TOKEN=xxx INGEST_TOKEN=xxx node perf-hot-sync.mjs
 */
const LV = (process.env.LV_URL || 'https://all48-lv.yqz-tansy.workers.dev').replace(/\/+$/, '');
const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const LV_TOKEN = process.env.LV_TOKEN || '';
const INGEST = process.env.INGEST_TOKEN || '';
const DRY = !!process.env.DRY;
const RUN_MIN = Math.max(1, Number(process.env.RUN_MINUTES || 55));
const TICK_MS = Math.max(15000, Number(process.env.TICK_MS || 25000));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BJ = 8 * 3600e3;
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(11, 19), ...a);
const BACKFILL_G = '补账';

const LVH = { 'x-lv-token': LV_TOKEN, 'x-ingest-token': INGEST, accept: 'application/json' };

/* ---------- ① 今天要盯的场次 + 我们这边每人多少（一次取回） ---------- */
async function board() {
  const d = new Date(Date.now() + BJ).toISOString().slice(0, 10).replace(/-/g, '');
  const r = await fetch(`${LV}/api/perf?from=${d}&to=${d}&cb=${Date.now()}`, { headers: LVH, signal: AbortSignal.timeout(25000) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`perf HTTP ${r.status} ${txt.slice(0, 80)}`);
  const j = JSON.parse(txt);
  const now = Date.now();
  return ((j && j.sessions) || []).filter((s) => s.id && s.st && s.st - 15 * 60e3 <= now && now < (s.et || s.st + 6 * 3600e3) + 5400e3)
    .map((s) => ({
      id: String(s.id), title: s.title || '', st: s.st, et: s.et,
      mine: new Map((s.members || []).map((x) => [Number(x.id), Number(x.val) || 0])),
    }));
}

/* ---------- ② liveId → { pageId, token } ---------- */
/** 数字 id 是自增库 id，只能扫页面比对 #vedio_id。窗口从上次命中的最大值往外扩。 */
let ANCHOR = Number(process.env.PERF_PAGE_ANCHOR || 0) || 0;
const PAGE_MAP = new Map();   // liveId → { pageId, token }

async function probePage(n) {
  try {
    const r = await fetch(`https://live.48.cn/Index/inlive/id/${n}`, {
      headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const h = await r.text();
    const vid = (h.match(/id="vedio_id"[^>]*value="(\d{15,})"/) || [])[1];
    const tk = (h.match(/id="param"\s+value="([a-f0-9]{16,})"/) || [])[1];
    if (!vid || !tk) return null;
    return { vid, tk, n };
  } catch { return null; }
}

async function mapPages(liveIds) {
  const need = liveIds.filter((id) => !PAGE_MAP.has(id));
  if (!need.length) return;
  if (!ANCHOR) ANCHOR = Number(process.env.PERF_PAGE_ANCHOR || 9713) || 9713;
  const span = Math.max(20, Number(process.env.PERF_PAGE_SPAN || 45));
  const nums = [];
  for (let d = 0; d <= span; d++) { nums.push(ANCHOR + d); if (d) nums.push(ANCHOR - d); }
  let maxHit = ANCHOR;
  const CONC = 12;
  for (let i = 0; i < nums.length && need.length; i += CONC) {
    const batch = nums.slice(i, i + CONC);
    // 🔴 单批必须加超时：实测有个别页面请求永不返回，Promise.all 会整轮卡死（2026-10-25）
    const res = await Promise.race([
      Promise.all(batch.map(probePage)),
      new Promise((r) => setTimeout(() => r([]), 9000)),
    ]);
    for (const o of res) {
      if (!o) continue;
      if (o.n > maxHit) maxHit = o.n;
      if (need.includes(o.vid) && !PAGE_MAP.has(o.vid)) {
        PAGE_MAP.set(o.vid, { pageId: o.n, token: o.tk });
        log(`✓ 找到页面 ${o.n} ↔ ${o.vid}`);
        const k = need.indexOf(o.vid); if (k >= 0) need.splice(k, 1);
      }
    }
  }
  if (maxHit > ANCHOR) ANCHOR = maxHit;
  if (need.length) log(`⚠️ 还有 ${need.length} 个场次没找到页面：${need.join(',')}`);
}

/* ---------- ③ 官方每人鸡腿 ---------- */
async function officialHot(liveId, page) {
  const body = new URLSearchParams({ act: 'default', video_id: String(liveId), token: page.token });
  const r = await fetch('https://live.48.cn/Index/ajax_getmemberhot/', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'user-agent': UA,
      referer: `https://live.48.cn/Index/inlive/id/${page.pageId}`,
    },
    body, signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!j || String(j.status) !== '200' || !Array.isArray(j.desc)) {
    // token 过期/场次结束：丢掉缓存，下一轮重新扫页面
    PAGE_MAP.delete(String(liveId));
    return null;
  }
  const m = new Map();
  for (const x of j.desc) {
    const mid = Number(x.memberId) || 0;
    const hot = Number(x.hot) || 0;
    if (mid && hot > 0) m.set(mid, hot);
  }
  return m;
}

/* ---------- ⑤ 差额补账 ---------- */
async function pushRows(rows) {
  if (!rows.length) return;
  if (DRY) { log(`(DRY) 会写 ${rows.length} 条：${JSON.stringify(rows.slice(0, 3))}`); return; }
  const r = await fetch(`${SITE}/api/lv/all`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST, 'x-lv-token': LV_TOKEN, 'user-agent': 'all48-perf-hot/1.0' },
    body: JSON.stringify({ ch: 'perf', items: rows }), signal: AbortSignal.timeout(25000),
  });
  const j = await r.json().catch(() => ({}));
  log(`⬆ 补账 ${rows.length} 条 → ${JSON.stringify(j.days || j)}`);
}

/* ---------- 主循环 ---------- */
const started = Date.now();
let stop = false;
process.on('SIGTERM', () => { stop = true; });
process.on('SIGINT', () => { stop = true; });

async function round() {
  const list = await board();
  if (!list.length) { log('没有在演/刚结束的公演'); return; }
  await mapPages(list.map((s) => s.id));
  const rows = [];
  for (const s of list) {
    const id = String(s.id);
    const page = PAGE_MAP.get(id);
    if (!page) continue;
    const off = await officialHot(id, page);
    if (!off) { log(`· ${s.title.slice(0, 12)} 官方接口暂无数据`); continue; }
    const mine = s.mine;
    let added = 0;
    for (const [mid, hv] of off) {
      const ov = mine.get(mid) || 0;
      const diff = hv - ov;
      if (diff > 0) {
        rows.push({ t: Date.now(), mid, sid: id, sn: BACKFILL_G, g: BACKFILL_G, num: 1, v: diff, room: 3 });
        added += diff;
        log(`  ${s.title.slice(0, 10)} mid=${mid} 官方 ${hv} 我们 ${ov} → 补 ${diff}`);
      }
    }
    if (!added) log(`✓ ${s.title.slice(0, 12)} 与官方一致（${off.size} 人有分）`);
  }
  log(`本轮：${list.length} 场在演/刚结束，补账 ${rows.length} 条`);
  await pushRows(rows);
}

log(`启动：最长 ${RUN_MIN} 分钟，${TICK_MS / 1000}s 一轮${DRY ? '（DRY）' : ''}`);
while (!stop && Date.now() - started < RUN_MIN * 60e3) {
  try { await round(); } catch (e) { log('轮次失败：' + String(e.message || e).slice(0, 90)); }
  await new Promise((r) => setTimeout(r, TICK_MS));
}
log('结束');
