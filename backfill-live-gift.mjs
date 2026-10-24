/**
 * 红蓝歌会 · 直播侧「弦月回响」补抓（回放弹幕 .lrc 兜底）
 * =====================================================================
 * 背景：直播送礼不走房间 IM（gift-sync 只覆盖房间），走云信 NIM 长连接，
 *   由 live-nim-sync.mjs 常驻监听。但 NIM 进程偶发进房失败 / 同账号多连接被踢，
 *   会漏掉整场直播的弦月回响（站长 2026-10-24 实测：kcy 直播间大量分数我们侧为 0）。
 *
 * 本脚本用「直播结束后的回放弹幕文件（getLiveOne → msgFilePath 的 .lrc）」做兜底补抓：
 *   凡是 live-nim-sync 漏掉的场次，这里都能从回放里捞回来。
 *
 * 原理：
 *   getLiveList(record:true) 翻出已结束的直播 → getLiveOne 拿 msgFilePath（.lrc 回放弹幕）
 *   → 解析「送给 SNH48-某某 N个弦月回响」→ 按北京时间归并 → POST /api/gift/ingest（src=1）
 *
 * 去重（两层，确保重跑不重复计分）：
 *   ① worker 端按 t|sid|mid|gid|num|src 去重；本脚本 t 由 ctime + 弹幕偏移 确定，
 *     同一次回放每次算出来都一致 ⇒ 重跑天然幂等。
 *   ② 用 gift:livecur 记已扫场次（liveId → 开播时间），二次运行直接跳过。
 *
 * 用法：
 *   node backfill-live-gift.mjs                  # 正式补抓（默认活动起点 2026-10-24 北京 0 点）
 *   DRY=1 node backfill-live-gift.mjs            # 只打印不写入
 *   SINCE=2026-10-24T00:00:00+08:00 node ...     # 自定义起点
 *   FORCE=1 node ...                             # 忽略已扫标记，全量重扫
 *   LIMIT=50 CONC=6 node ...                     # 限量 / 并发
 *   MAX_PAGES=3 CONC=6 node ...                  # 只翻当天那几页（高频快扫用）
 *   node backfill-live-gift.mjs --selftest       # 离线校验 LRC 解析（无需任何网络）
 *
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN / POCKET48_TOKEN / SCRAPE_PROXY
 */
import { postJson, fetchText } from './lib/api.mjs';
import { createGiftParser } from './lib/nim-parse.mjs';

/* -------------------------------------------------------------- 参数 */
const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const ROOT = process.env.SITE_URL
  ? (process.env.SITE_URL.replace(/\/+$/, '') + '/api/gift')
  : 'https://all48.wyc0518.cc/api/gift';
const DRY = !!process.env.DRY || process.argv.includes('--selftest') === false && !!process.env.DRY;
const SELFTEST = process.argv.includes('--selftest');
const FORCE = !!process.env.FORCE;
const LIMIT = Math.max(0, Number(process.env.LIMIT || 0));
const CONC = Math.max(1, Number(process.env.CONC || 6));
// 列表最多翻几页（高频快扫用：只要当天那几页，别每次都翻 40 页）
const MAX_PAGES = Math.max(1, Number(process.env.MAX_PAGES || 40));

// 活动起点（北京）：默认「北京今天 0 点往前再退 6 小时」
// 🔴 为什么不再写死 2026-10-24：这个脚本现在挂在 2 分钟快扫里天天跑，
//    写死日期到第二天就再也扫不到新场次，而且从页面上只表现为「直播分不动」。
// 🔴 为什么退 6 小时：23:50 开播、00:20 结束那种场次，ctime 落在「昨天」——
//    只按今天 0 点起算会整场跳过；已扫标记（gift:livecur）保证退回去也不会重复计分。
const BJ = 8 * 3600 * 1000;
function todayBjStart() {
  return Math.floor((Date.now() + BJ) / 86400000) * 86400000 - BJ;
}
function parseSince(s) {
  if (!s) return todayBjStart() - 6 * 3600 * 1000;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?(\+\d{2}:?\d{2})?$/.exec(s.trim());
  if (m) {
    const [, y, mo, d, hh = 0, mi = 0, ss = 0] = m;
    return Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) - BJ;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : todayBjStart() - 6 * 3600 * 1000;
}
const SINCE = parseSince(process.env.SINCE);

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------- LRC 解析（纯函数） */
// 回放弹幕一行：「[HH:MM:SS.mmm]昵称<TAB>送给SNH48-某某 N个弦月回响」
// 时间偏移是相对「开播 ctime」的，绝对时间 = ctime + 偏移。
const RE_LINE = /^\[(\d+):(\d+):([\d.]+)\]([^\t]*)\t(.*)$/;
const RE_GIFT = /送给\s*(\S+?)\s*(\d+)\s*个\s*(.+)$/;

/**
 * 解析一段 .lrc 文本，抽出目标礼物的送礼记录。
 * @param {string} text    .lrc 全文
 * @param {number} ctime   本场开播时间（ms）
 * @param {string} NAME    目标礼物名（如「弦月回响」）
 * @param {(raw:string)=>number} memberUid  昵称→uid（见 nim-parse.mjs）
 * @returns {{items:object[], hits:number, skipped:number, lines:number}}
 *   每条 item：{ t, mid, sid:0, sn, gid:'', g:NAME, num, src:1, _to }
 */
export function parseLrc(text, ctime, NAME, memberUid) {
  const items = [];
  let hits = 0, skipped = 0, lines = 0, other = 0;
  if (!text) return { items, hits, skipped, lines, other };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = RE_LINE.exec(line);
    if (!m) continue;            // 非「时间+昵称+正文」的行（如纯时间轴）忽略
    lines++;
    const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]);
    const nick = m[4].trim();
    const body = m[5];
    const g = RE_GIFT.exec(body);
    if (!g) continue;            // 不是送礼行（普通弹幕 / 系统提示）
    const to = g[1];
    const num = Math.max(1, Math.floor(Number(g[2]) || 1));
    const gname = g[3].trim();
    if (gname.indexOf(NAME) < 0) { other++; continue; }   // 不是目标礼物（荧光棒等）→ 不计分
    const mid = memberUid ? memberUid(to) : 0;
    if (!mid) { skipped++; continue; }        // 收礼人不在成员目录 → 无法归户，跳过
    const offsetMs = Math.round((hh * 3600 + mm * 60 + ss) * 1000);
    items.push({
      t: Number(ctime) + offsetMs,
      mid,
      sid: 0,                      // 直播弹幕只有昵称没有 uid
      sn: nick.slice(0, 40),
      gid: '',                     // 回放里没有 giftId，靠礼物名匹配
      g: NAME,
      num,
      src: 1,                      // 1 = 直播侧
      _to: to,
    });
    hits++;
  }
  return { items, hits, skipped, lines, other };
}

/* ----------------------------------------------------- 成员目录（归户） */
async function loadRoster() {
  if (!SITE) { log('⚠️ 没配 SITE_URL，无法加载成员目录（收礼人无法归户，全部跳过）'); return new Map(); }
  for (let i = 0; i < 5; i++) {
    try {
      const txt = await (await fetch(SITE + '/data/members.js')).text();
      const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
      const map = new Map();
      for (const m of arr) {
        if (!m || !m.n) continue;
        const k = String(m.n).trim();
        if (!map.has(k)) map.set(k, Number(m.id));
      }
      log(`成员目录 ${arr.length} 人（可反查 ${map.size} 个昵称）`);
      return map;
    } catch (e) {
      log(`成员目录取不到（第 ${i + 1} 次）：${String(e.message).slice(0, 90)}`);
      await sleep(3000 * (i + 1));
    }
  }
  return new Map();
}

/* ----------------------------------------------- 站点读：cfg + 已扫场次 */
async function loadCursor() {
  if (!INGEST || !SITE) return { cfg: { name: '弦月回响', ids: [] }, lives: {}, sse: {} };
  try {
    const j = await (await fetch(SITE + '/api/gift/cursor', {
      headers: { 'x-ingest-token': INGEST, Accept: 'application/json' },
    })).json();
    const cfg = (j && j.cfg) || {};
    const lives = (j && j.lives) || {};
    // 直播侧「实时已覆盖」的场次（live-sse-sync.mjs 登记的）—— 这些场次已经实时计入，
    // 再扫一遍 LRC 会因为时间戳口径不同而被 worker 当成新记录 ⇒ 重复计分。
    const sse = (j && j.sse) || {};
    log(`站点配置：目标礼物「${cfg.name || '弦月回响'}」 · 已扫直播 ${Object.keys(lives).length} 场 · 实时已覆盖 ${Object.keys(sse).length} 场`);
    return {
      cfg: { name: cfg.name || '弦月回响', ids: Array.isArray(cfg.ids) ? cfg.ids : [] },
      lives,
      sse,
    };
  } catch (e) {
    log('读站点游标失败（用默认 弦月回响）：' + String(e.message).slice(0, 90));
    return { cfg: { name: '弦月回响', ids: [] }, lives: {}, sse: {} };
  }
}

/* ----------------------------------------------- 回放文件下载（支持代理） */
// 回放 .lrc 在口袋48 CDN（海外直连 403），国内机器直连即可；
// 若在 GitHub Actions（海外）跑，需要走 SCRAPE_PROXY。这里复用 api.mjs 同款 CONNECT 隧道。
// 统一走 lib/api.mjs 的 fetchText（node:https + https-proxy-agent，先直连后退代理、自动跟 3 次重定向）。
// 🔴 别再 import 'undici'：本机没装这个包，旧写法一进代理分支就炸。
const fetchLrc = (url) => fetchText(url, { timeout: 40000 });

/* --------------------------------------------------- 在播/已播列表翻页 */
async function collectSessions() {
  const all = [];
  let next = '0';
  for (let p = 0; p < MAX_PAGES; p++) {
    const r = await postJson('/live/api/v1/live/getLiveList',
      { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 3 });
    const c = (r && r.content) || {};
    const list = c.liveList || [];
    if (!list.length) break;
    for (const x of list) {
      const ctime = Number(x.ctime) || 0;
      all.push({
        liveId: String(x.liveId || ''),
        uid: String((x.userInfo && x.userInfo.userId) || ''),
        nick: String((x.userInfo && x.userInfo.nickname) || ''),
        ctime,
      });
    }
    const nx = String(c.next || '0');
    if (!nx || nx === '0' || nx === String(next)) break;
    next = nx;
    // 🔴 整页都早于起点才停（原来是「页内碰到一个早于起点的就 break」，
    //    列表只要有一场 ctime 乱序就会整批截断 —— 实测因此漏了 10 场）
    const times = list.map((x) => Number(x.ctime) || 0).filter(Boolean);
    if (times.length && Math.max(...times) < SINCE) break;
  }
  // 去重 + 过滤起点
  const seen = new Set();
  const uniq = [];
  for (const s of all) {
    if (!s.liveId || seen.has(s.liveId)) continue;
    if (s.ctime < SINCE) continue;          // 起点之前的不扫
    seen.add(s.liveId);
    uniq.push(s);
  }
  return uniq;
}

/* ----------------------------------------------------------- 上报 */
async function ingest(items, lives) {
  if (DRY) {
    log(`[DRY] 本应上报 ${items.length} 条礼物 + 标记 ${Object.keys(lives).length} 场已扫`);
    return { ok: true, dry: true };
  }
  const BATCH = 2000;
  let added = 0;
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const res = await fetch(SITE + '/api/gift/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify({
        items: chunk,
        stats: { ['直播补抓·' + NAME]: chunk.length },
      }),
    });
    const out = await res.json().catch(() => ({}));
    added += Number(out && out.added) || 0;
    log(`↑ 上报 ${chunk.length} 条 → kept=${out.kept} added=${out.added}`);
  }
  // 标记已扫场次（幂等：重跑不会重复计分，只是更新 livecur）
  if (Object.keys(lives).length) {
    const res = await fetch(SITE + '/api/gift/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify({ items: [], lives }),
    });
    const out = await res.json().catch(() => ({}));
    log(`↩ 标记已扫场次 ${Object.keys(lives).length} 场 → ${JSON.stringify(out).slice(0, 80)}`);
  }
  return { ok: true, added };
}

/* --------------------------------------------------------- 主流程 */
let NAME = '弦月回响';

async function main() {
  const t0 = Date.now();
  log(`=== 直播侧「${NAME}」回放补抓 起算 ${new Date(SINCE + BJ).toISOString().slice(0, 19)} (北京) ===`);

  const roster = await loadRoster();
  const { cfg, lives: scanned, sse: sseCovered } = await loadCursor();
  NAME = cfg.name || '弦月回响';
  const { memberUid } = createGiftParser(cfg, roster);

  const sessions = await collectSessions();
  log(`候选直播 ${sessions.length} 场（>= 起点）`);

  // 待处理：未扫过（或 FORCE）且有回放文件
  const todo = sessions.filter((s) => FORCE || !scanned[s.liveId]);

  // 🔴 实时已覆盖的场次跳过（2026-10-25）：直播中的礼物已由 live-sse-sync.mjs 实时上报，
  //    再扫一遍 LRC 会因为时间戳口径不同（serverTime vs ctime+偏移）被 worker 当成新记录 ⇒ 重复计分。
  //    判定：SSE 首次建连时间 <= 开播时间 + 5 分钟 ⇒ 从头就在看，可以放心跳过。
  //    中途才参与的不跳过（宁可重复也不能漏）。
  const sseSkip = [];
  const todo2 = todo.filter((s) => {
    const first = Number(sseCovered[String(s.liveId)] || 0);
    if (!first) return true;
    const ctimeMs = Number(s.ctime) || 0;
    if (first <= ctimeMs + 5 * 60000) { sseSkip.push(s.liveId); return false; }
    return true;
  });
  if (sseSkip.length) log(`实时已覆盖 ${sseSkip.length} 场，跳过不重复扫`);
  todo.length = 0;
  todo.push(...todo2);

  log(`${FORCE ? 'FORCE 全量' : '未扫'} ${todo.length} 场待处理${LIMIT ? '（限 ' + LIMIT + '）' : ''}`);
  if (LIMIT) todo.length = Math.min(todo.length, LIMIT);

  const caught = [];       // 本批成功处理的场次
  const liveLives = {};    // liveId → ctime，用于标记已扫
  let grandHits = 0, grandSkip = 0, grandNoLrc = 0, grandErr = 0, grandEmpty = 0;
  const allItems = [];

  // 并发池
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= todo.length) return;
      const s = todo[i];
      let one;
      try {
        one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: s.liveId }, { token: TOKEN, retries: 2 })).content || {};
      } catch (e) {
        grandErr++;
        if (grandErr <= 10) log(`  [${s.nick || s.liveId}] getLiveOne 失败：${String(e.message).slice(0, 70)}`);
        continue;
      }
      const url = one.msgFilePath;
      if (!url) { grandNoLrc++; continue; }   // 还在播 / 无回放
      let text = '';
      try { text = await fetchLrc(url); }
      catch (e) { grandErr++; if (grandErr <= 10) log(`  [${s.nick || s.liveId}] 下载回放失败：${String(e.message).slice(0, 70)}`); continue; }
      const { items, hits, skipped, lines } = parseLrc(text, s.ctime, NAME, memberUid);
      grandHits += hits; grandSkip += skipped;
      if (hits) {
        allItems.push(...items);
        caught.push({ liveId: s.liveId, nick: s.nick, hits });
        log(`  ✅ [${s.nick || s.liveId}] ${hits} 个弦月回响（归户失败 ${skipped}）`);
      } else {
        log(`  ·  [${s.nick || s.liveId}] 回放无目标礼物（行数 ${lines} · 归户失败 ${skipped}）`);
      }
      // 🔴 空回放（0 行）**不能标记已扫**：刚结束那几分钟 msgFilePath 可能已经给了，
      //    但文件内容还是空的（CDN 那头还在写）。标了就等于永久跳过这一场 —— 分数永远补不回来。
      //    不标记 ⇒ 下一轮再来一次，等文件写完就能拿到。真实 0 送礼的场次「行数」不会是 0。
      if (lines === 0) { grandEmpty++; continue; }
      liveLives[s.liveId] = s.ctime;   // 有内容就标记已扫（有没有目标礼物都算扫过）
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, todo.length) }, worker));

  await ingest(allItems, liveLives);

  log(`完成：处理 ${caught.length} 场有分 · 无回放 ${grandNoLrc} · 空回放(下轮重试) ${grandEmpty} · 错误 ${grandErr}`);
  log(`本批弦月回响 ${grandHits} 个（归户失败 ${grandSkip}） · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (caught.length) {
    log('有分的场次：' + caught.map((c) => `${c.nick || c.liveId}(${c.hits})`).slice(0, 20).join(' '));
  }
}

/* --------------------------------------------------------- 离线自检 */
async function selftest() {
  console.log('=== LRC 解析自检（无需网络）===');
  const roster = new Map([['康楚翊', 1001], ['左婧媛', 1002]]);
  const { memberUid } = createGiftParser({ name: '弦月回响', ids: [] }, roster);
  const sample = [
    '[00:00:00.000]系统\t直播开始',
    '[00:01:23.500]小明\t送给SNH48-康楚翊 8个弦月回响',
    '[00:02:00.000]小红\t送给 SNH48-康楚翊 2个弦月回响',
    '[00:03:00.000]小刚\t送给GNZ48-左婧媛 1个弦月回响',
    '[00:04:00.000]小美\t送给SNH48-康楚翊 5个荧光棒',
    '[01:05:30.250]阿强\t送给SNH48-康楚翊 3个弦月回响',
    '[00:06:00.000]无名\t送给 不存在的人 1个弦月回响',
  ].join('\n');
  const ctime = Date.UTC(2026, 9, 24, 0, 0, 0) - BJ; // 2026-10-24 北京 0 点
  const { items, hits, skipped, lines, other } = parseLrc(sample, ctime, '弦月回响', memberUid);
  const total = items.reduce((a, b) => a + b.num, 0);
  console.log('解析行数', lines, '命中', hits, '非目标礼物', other, '归户失败', skipped, '合计份数', total);
  console.log('明细:');
  for (const it of items) {
    console.log(`  t=${new Date(it.t + BJ).toISOString().slice(0, 19)} mid=${it.mid} ${it.sn}→${it._to} ×${it.num} src=${it.src}`);
  }
  // 4 条目标礼物（8+2+1+3）；荧光棒属非目标礼物（other=1）；「不存在的人」归户失败 1
  const expect = 4; // 8+2+1+3
  const expectSum = 14;
  const ok = hits === expect && total === expectSum && skipped === 1 && other === 1;
  console.log(ok ? '✅ 自检通过' : `❌ 自检失败（期望命中 ${expect} 合计 ${expectSum} 归户失败 1 非目标 1）`);
  process.exit(ok ? 0 : 1);
}

if (SELFTEST) { await selftest(); }
else if (!SITE || !INGEST || !TOKEN) {
  console.error('缺少环境变量：需要 SITE_URL / INGEST_TOKEN / POCKET48_TOKEN（DRY 模式也要 SITE_URL 加载成员目录）');
  if (!DRY) process.exit(1);
  log('（DRY 模式：无凭据仅打印，不写站点）');
  await main();
} else {
  await main();
}
