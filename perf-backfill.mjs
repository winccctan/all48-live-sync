#!/usr/bin/env node
/**
 * perf-backfill.mjs —— 公演场次「按官方快照补差额」
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 公演礼物只能靠「开演时盯弹幕流」当场记，**流断了就不能回放**：
 *   · getOpenLiveOne 没有 msgFilePath（没有回放弹幕文件）
 *   · IM 接口对公演聊天室一律「目标不存在」（probe-perf-room.mjs 已验）
 *   · 官方 getLiveRank 只有 type=1（空）和 type=2（送礼人榜），拿不到成员维度
 *   · xox48.top 的「公演坤腿查询」接口（/Api/load_gy、/Api/load_gyc）回「群内查询」，
 *     非群成员拿不到（2026-10-25 实测，连真浏览器直连也一样）
 * 2026-10-25 13:47–14:34 就因为采集端 MAX_ROOMS=4 把最早开演的场次挤出监听名单，
 * 整段永久缺失 ⇒ 只能拿**官方成员榜快照**做差额补入。
 *
 * ── 差额怎么算 ───────────────────────────────────────────────────────
 *   补入量 = 官方快照值 − 我们在该快照时刻的累计
 * 于是：
 *   · 快照之后我们抓到的部分原样保留（不覆盖、不重算）
 *   · 快照之前我们已经抓到的部分不会被重复计（在减项里）
 *   · 同一份快照重复跑是幂等的（差额会算成 0，且 lvKey 去重兜底）
 *
 * ── 铁律 ─────────────────────────────────────────────────────────────
 * 🔴 只增不删：只补「我们少的」，绝不按官方值覆盖我们的记录。
 * 🔴 不猜：名册查不到的成员名直接跳过并打日志，绝不按「像谁」硬塞。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   cd all48-live-sync
 *   DRY=1 node perf-backfill.mjs perf-backfill.json    # 先看对照表
 *   INGEST_TOKEN=xxx node perf-backfill.mjs perf-backfill.json
 *
 * 清单格式（一场一条；at = 官方快照上的北京时间）：
 *   [ { "liveId": "1319980937988870144", "at": "2026-10-25T14:50:52+08:00",
 *       "rows": [ { "n": "蔡佩宸", "v": 340 }, { "n": "周是汝", "v": 125 } ] } ]
 */
import { readFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
// 「我们这场抓到了多少」要问 lv 站：归场逻辑和价目表都在它那边
const LV = (process.env.LV_URL || 'https://all48-lv.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const DRY = !!process.env.DRY;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BJ = 8 * 3600e3;
const BACKFILL_G = '补账';   // 必须与 all48-lv/worker/index.js 的 BACKFILL_G 一致

const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(11, 19), ...a);
const bj = (ms) => new Date(ms + BJ).toISOString().slice(5, 16).replace('T', ' ');

const file = process.argv[2];
if (!file) { console.error('用法：node perf-backfill.mjs <清单.json>'); process.exit(1); }
const plan = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(plan) || !plan.length) { console.error('清单为空'); process.exit(1); }

/* ---------- ① 名册（名字 → mid） ---------- */
const txt = await (await fetch(SITE + '/data/members.js?v=' + Date.now(), { headers: { 'User-Agent': UA } })).text();
const roster = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const byName = new Map();
for (const m of roster) {
  const n = String(m.n || '').replace(/\s+/g, '');
  if (n && m.id) byName.set(n, m);
}
log(`名册 ${roster.length} 人`);

/** 我们在「某场次 + 某时刻之前」给某成员记了多少鸡腿 */
async function oursBefore(mid, liveId, until) {
  const u = `${LV}/api/perf/one?mid=${mid}&sid=${liveId}&until=${until}&cb=${Date.now()}`;
  const r = await fetch(u, { headers: { 'User-Agent': UA, accept: 'application/json', 'cache-control': 'no-cache' } });
  if (!r.ok) throw new Error(`perf/one HTTP ${r.status}`);
  const j = await r.json();
  const rows = Array.isArray(j.rows) ? j.rows : [];
  return rows.reduce((a, x) => a + (Number(x.v) || 0), 0);
}

/* ---------- ② 逐场对账 ---------- */
const payload = [];
const report = [];
for (const s of plan) {
  const liveId = String(s.liveId || '');
  const at = Date.parse(s.at);
  if (!liveId || !at) { log('⚠️ 跳过格式不对的一条：' + JSON.stringify(s).slice(0, 80)); continue; }

  log(`\n== ${s.title || liveId} @ ${bj(at)} ==`);
  let add = 0, cnt = 0;
  for (const row of s.rows || []) {
    const name = String(row.n || '').replace(/\s+/g, '');
    const off = Math.max(0, Number(row.v) || 0);
    const mem = byName.get(name);
    if (!mem) { log(`  ⚠️ 名册里没有「${row.n}」，跳过（不猜）`); continue; }
    let ours = 0;
    try { ours = await oursBefore(mem.id, liveId, at); }
    catch (e) { log(`  ${name} 查我们累计失败：${String(e.message).slice(0, 60)}`); continue; }
    const diff = off - ours;
    report.push({ 成员: name, 官方: off, 我们: ours, 补: diff });
    if (diff <= 0) continue;
    add += diff; cnt++;
    payload.push({ t: at, mid: mem.id, sid: liveId, sn: '补账', g: BACKFILL_G, num: 1, v: diff, room: 3 });
  }
  log(`  本场补入 ${add} 鸡腿 / ${cnt} 人`);
}

console.log('\n成员        官方     我们      补');
for (const r of report) {
  console.log(`${r.成员.padEnd(10)} ${String(r.官方).padStart(6)} ${String(r.我们).padStart(8)} ${String(r.补 > 0 ? r.补 : '-').padStart(7)}`);
}
const total = payload.reduce((a, x) => a + x.v, 0);
console.log(`\n合计补入 ${total} 鸡腿 / ${payload.length} 条`);

if (DRY) { console.log('[DRY] 不写入'); process.exit(0); }
if (!payload.length) { console.log('没有需要补的'); process.exit(0); }
if (!INGEST) { console.error('缺少 INGEST_TOKEN，无法写入'); process.exit(1); }

/* ---------- ③ 写入（分批） ---------- */
let ok = 0, fail = 0;
for (let i = 0; i < payload.length; i += 300) {
  const part = payload.slice(i, i + 300);
  try {
    const r = await fetch(SITE + '/api/lv/all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA, 'x-ingest-token': INGEST },
      body: JSON.stringify({ ch: 'backfill', items: part }),
    });
    const j = await r.json().catch(() => ({}));
    ok += part.length;
    console.log(`写入 ${part.length} 条 →`, JSON.stringify(j.days || j).slice(0, 180));
  } catch (e) {
    fail += part.length;
    console.log('写入失败：' + String(e.message).slice(0, 120));
  }
}
console.log(`\n完成：写入 ${ok} 条 / 失败 ${fail} 条`);
if (fail) process.exitCode = 1;
