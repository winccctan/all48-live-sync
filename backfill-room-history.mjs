/**
 * 回补「房间礼物」历史（lv:all）—— 2026-10-27 站长：「能不能把鸡腿的数据补充到10月1日开始到现在」
 * =====================================================================================
 * 背景：鸡腿榜（lv:all）原本只有 10/17 往后那点数据，10/17–10/23 每天才几十条。
 *   原因是定时任务只扫「北京昨天 0 点」往后，历史从来没回补过。
 *
 * 🔴 2026-10-27 关键实测（推翻了此前「单房间只能翻 8 天」的判断）：
 *   口袋48 房间消息的翻页深度**远不止 6000 条**。覃柯蒙 room 一路翻到
 *   **406 页 / 20300 条 / 9-30 23:09**（214 秒），刘星雨 55 页到 9-30。
 *   之前那个「8 天上限」是本机脚本把 PAGES 写成 120 造成的假象。
 *
 * 做法：逐房间从最新往回翻，一直翻到 SINCE 之前；把每条礼物消息按
 *   `[t,mid,sid,sn,g,num,v,room,ch]`（9 位，room=1，ch='hist'）推给
 *   `POST /api/lv/all`，由 worker 用 `lvKey=t|mid|g|num|room` 去重、按北京日归档。
 *   ⇒ 与现有管线**同一把键**，重复跑是幂等的，不会翻倍。
 *
 * 🔴 送礼人 uid 这里**要带**（与 gift-sync 的 sid:0 不同）：
 *   房间消息的 `ext.user.userId` 是真实 uid，带上之后「送分人 ↔ 送鸡腿人」的
 *   重合度判定就是 uid 级的，不再依赖昵称归并（昵称会改名，uid 不会）。
 *   老行 sid=0 也不冲突：demo 里 `ident()` 的 nick2u 索引会从带 uid 的行学到映射。
 *
 * 用法：
 *   node backfill-room-history.mjs                      # 10/1 → 现在
 *   SINCE=2026-09-01T00:00:00+08:00 node backfill-room-history.mjs
 *   DRY=1 node backfill-room-history.mjs                # 只统计不上报
 *   ONLY_UIDS=123,456 node ...                          # 只跑指定成员（调试）
 *   CONC=9 PAGES=900 node ...                           # 并发 / 单人最大页数
 */
import { readFileSync, existsSync } from 'node:fs';
import { fetchMessagePage } from './lib/api.mjs';
import { priceOf } from './lib/gift-price.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const envFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pickEnv = (txt, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};

const LIVE_ENV = envFile(ROOT + 'nim-sync.env');
const WRK_ENV = envFile(ROOT + '../all48-worker/.env');
const TOKEN = process.env.POCKET48_TOKEN || pickEnv(LIVE_ENV, 'POCKET48_TOKEN');
const SITE = (process.env.SITE_URL || pickEnv(LIVE_ENV, 'SITE_URL') || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const LV_TOKEN = process.env.LV_TOKEN || pickEnv(WRK_ENV, 'LV_TOKEN');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SINCE = Date.parse(process.env.SINCE || '2026-10-01T00:00:00+08:00');
const UNTIL = Date.parse(process.env.UNTIL || '') || Date.now() + 3600e3;
const CONC = Math.max(1, Number(process.env.CONC || 9));
const MAXPAGES = Math.max(1, Number(process.env.PAGES || 900));
const PAGE_LIMIT = 50;              // 🔴 上限就是 50，传更大也只回 50
const DRY = !!process.env.DRY;
const ONLY = new Set(String(process.env.ONLY_UIDS || '').split(',').map((s) => Number(s.trim())).filter(Boolean));
/* 🔴 分片（Actions 上用）：整团往回翻一年要 5000+ 页/房间，单机跑不完。
   按 uid 取模切片，每个 job 一份，互不重叠；站点侧按 t|mid|g|num|room 去重，重跑幂等。 */
const SHARD = Math.max(0, Number(process.env.SHARD || 0));
const SHARDS = Math.max(1, Number(process.env.SHARDS || 1));
/* 上报令牌：本地有 LV_TOKEN，Actions 只有 INGEST_TOKEN（worker 的 lvOk 认 x-ingest-token） */
const INGEST_TOKEN = process.env.INGEST_TOKEN || pickEnv(WRK_ENV, 'INGEST_TOKEN');

if (!TOKEN) throw new Error('缺少 POCKET48_TOKEN');
if (!DRY && !LV_TOKEN && !INGEST_TOKEN) throw new Error('缺少 LV_TOKEN / INGEST_TOKEN（写在 ../all48-worker/.env）');

const BJ = 8 * 3600e3;
const bj = (t) => new Date(t + BJ).toISOString().slice(0, 19).replace('T', ' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* -------------------------------------------------- ① 名册 */
async function loadRoster() {
  let txt = '';
  try {
    const r = await fetch(SITE + '/data/members.js?v=' + Date.now(), { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    txt = await r.text();
  } catch (e) {
    log('线上名册取不到（' + String(e.message).slice(0, 60) + '），改读仓库快照');
    txt = readFileSync(ROOT + '../all48-worker/public/data/members.js', 'utf8');
  }
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  return arr.filter((m) => m && m.id && m.srv && m.ch && String(m.tm || '').indexOf('荣誉') < 0);
}

/* -------------------------------------------------- ② 解析一条礼物消息（与 gift-sync 同口径） */
function parseGift(m, mid) {
  let ext = {};
  try { ext = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : (m.extInfo || {}); } catch { ext = {}; }
  const u = ext.user || {};
  const sid = Number(u.userId) || 0;
  const sn = String(u.nickname || u.nickName || '').slice(0, 40);
  const t = Number(m.msgTime) || 0;
  if (!t) return null;
  let ct = {};
  try { ct = typeof m.bodys === 'string' ? JSON.parse(m.bodys) : (m.bodys || {}); } catch { return null; }
  const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
  if (!gi) return null;
  const g = String(gi.giftName || '');
  const gid = String(gi.giftId || '');
  const num = Math.max(1, Math.floor(Number(gi.giftNum) || 1));
  return {
    t, mid, sid, sn, g, num,
    v: priceOf(gid, g),
    room: 1,
    ch: 'hist',
  };
}

/* -------------------------------------------------- ③ 上报 */
let pushed = 0, addedTotal = 0;
async function push(items) {
  if (!items.length) return;
  if (DRY) { pushed += items.length; return; }
  for (let i = 0; i < items.length; i += 1500) {
    const part = items.slice(i, i + 1500);
    for (let k = 0; k < 4; k++) {
      try {
        const r = await fetch(SITE + '/api/lv/all', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': UA,
            'x-lv-token': LV_TOKEN || '',
            'x-ingest-token': INGEST_TOKEN || '',
          },
          body: JSON.stringify({ ch: 'hist', items: part }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100));
        const j = await r.json();
        let add = 0;
        for (const d of Object.values(j.days || {})) add += Number(d.added || 0);
        addedTotal += add;
        pushed += part.length;
        log(`上报 ${part.length} 条 → 新增 ${add}`);
        break;
      } catch (e) {
        if (k === 3) { log('上报失败：' + String(e.message).slice(0, 140)); break; }
        await sleep(1500 * (k + 1));
      }
    }
  }
}

/* -------------------------------------------------- ④ 主流程 */
const roster = await loadRoster();
let targets = roster;
if (ONLY.size) targets = roster.filter((m) => ONLY.has(Number(m.id)));
if (SHARDS > 1) targets = targets.filter((m) => (Number(m.id) % SHARDS) === SHARD);
log(`名册可用 ${roster.length} 人，本轮扫 ${targets.length} 个房间${SHARDS > 1 ? `（分片 ${SHARD + 1}/${SHARDS}，按 uid 取模）` : ''} · 目标 ${bj(SINCE)} ~ ${bj(UNTIL)} · 并发 ${CONC}`);

const seenKey = new Set();     // 本次运行内去重（lvKey 同款）
let cursor = 0, pageTotal = 0, msgTotal = 0, giftTotal = 0, doneN = 0;
const perDay = {};
let buf = [];
const t0 = Date.now();

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= targets.length) return;
    const m = targets[i];
    const mid = Number(m.id);
    let next = 0, pages = 0, oldest = Infinity, gifts = 0, err = 0;
    while (pages < MAXPAGES) {
      let r;
      try {
        r = await fetchMessagePage({ serverId: m.srv, channelId: m.ch, nextTime: next, limit: PAGE_LIMIT, token: TOKEN, scope: 'all' });
      } catch (e) {
        err++;
        if (err > 3) { log(`[${m.n}] 连续出错，跳过：${String(e.message).slice(0, 80)}`); break; }
        await sleep(1200 * err);
        continue;
      }
      const msgs = r.messages || [];
      if (!msgs.length) break;
      pages++; pageTotal++; msgTotal += msgs.length;
      for (const x of msgs) {
        const t = Number(x.msgTime) || 0;
        if (t && t < oldest) oldest = t;
        if (!t || t < SINCE || t >= UNTIL) continue;
        const g = parseGift(x, mid);
        if (!g) continue;
        const key = [g.t, g.mid, g.g, g.num, g.room].join('|');
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        gifts++; giftTotal++;
        perDay[bj(g.t).slice(0, 10)] = (perDay[bj(g.t).slice(0, 10)] || 0) + 1;
        buf.push(g);
      }
      if (buf.length >= 3000) { const b = buf; buf = []; await push(b); }
      if (oldest <= SINCE) break;
      if (!r.nextTime || String(r.nextTime) === '0' || String(r.nextTime) === String(next)) break;
      next = r.nextTime;
      await sleep(40);
    }
    doneN++;
    if (doneN % 25 === 0) {
      log(`进度 ${doneN}/${targets.length} · 已扫 ${pageTotal} 页 ${msgTotal} 条 · 礼物 ${giftTotal} 条 · 用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分`);
    }
    if (gifts) log(`  · ${m.n}(${mid}) ${pages} 页 → 最旧 ${oldest < Infinity ? bj(oldest) : '-'} · 礼物 ${gifts}`);
  }
}

await Promise.all(Array.from({ length: CONC }, worker));
if (buf.length) await push(buf);

log(`\n=== 完成 ===`);
log(`房间 ${targets.length} 个 · 扫 ${pageTotal} 页 ${msgTotal} 条消息 · 礼物行 ${giftTotal} 条 · 上报 ${pushed} 条 · 实际新增 ${addedTotal} 条`);
log(`用时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
log('按日分布：' + JSON.stringify(perDay, null, 0));
