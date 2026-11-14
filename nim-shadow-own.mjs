#!/usr/bin/env node
/**
 * 云信影子 vs 「我们自己线上库」对账（2026-11-11）
 * =============================================
 * 为什么不用 nim-shadow-diff.mjs：那个是拿第三方 gnz.hk 当基准。
 * 站长要判断的是「自建云信能不能顶掉现在这条（xox 回补 + 48fan SSE）」，
 * 所以基准必须是**我们自己的线上库**。
 *
 * 数据源：
 *   · 云信影子  nim-state/dry-YYYYMMDD.jsonl（client.mjs DRY=1 时落盘，一行一笔，带单价）
 *   · 线上库    R2 gift:day:YYYYMMDD，行格式 [t, mid, sid, sn, gid, num, src, ch]
 *
 * 🔴 窗口必须取两边时间的**交集**：影子只有进程跑起来之后才有数据，
 *    直接按影子的 tMax 回推一小时，等于拿线上单边时段来比，会得出一堆假漏。
 *
 * 对齐键：收礼成员 mid + 份数 num + 时间 ±10 秒。
 *   🔴 不能用 gid：线上行里的 gid 一律是空串（老源没存）。
 *   🔴 不能用 sid：线上 xox/sse 源的送礼人 uid 一律 0，只有云信这条带真 uid。
 *
 * 用法：
 *   node nim-shadow-own.mjs                 # 默认看最近 2 小时交集
 *   node nim-shadow-own.mjs --hours=6
 *   node nim-shadow-own.mjs --day=20261111
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname);
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)=?(.*)$/.exec(a);
  return m ? [m[1], m[2] || true] : [a, true];
}));
const HOURS = Number(argv.hours || 2);
const DAY = String(argv.day || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));
const bj = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' ');

/* ---------- 1. 云信影子 ---------- */
const f = resolve(ROOT, 'nim-state', 'dry-' + DAY + '.jsonl');
let nimAll = [];
if (fs.existsSync(f)) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { nimAll.push(JSON.parse(line)); } catch { /* 半行 */ }
  }
}
let nim = nimAll.filter((x) => Number(x.src) === 1);
console.log(`云信影子：文件 ${nimAll.length} 行，其中直播(src=1) ${nim.length} 条`);

/* ---------- 2. 线上库 ---------- */
const env = Object.fromEntries(fs.readFileSync('/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/.env', 'utf8')
  .split('\n').filter((l) => /^[A-Z_0-9]+=/.test(l)).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()];
  }));
const ACC = env.CLOUDFLARE_ACCOUNT_ID || '059eb69ea08bb69928d246c8149fa9b3';
const url = `https://api.cloudflare.com/client/v4/accounts/${ACC}/r2/buckets/all48-arc/objects/${encodeURIComponent('gift:day:' + DAY)}`;
let own = [];
try {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  let txt;
  try { txt = zlib.gunzipSync(buf).toString('utf8'); } catch { txt = buf.toString('utf8'); }
  own = (JSON.parse(txt).items || []).filter((x) => Number(x[6]) === 1);
} catch (e) {
  console.log('拉线上库失败：' + e.message);
  process.exit(1);
}
console.log(`线上库：全天 src=1 共 ${own.length} 条`);

if (!nim.length || !own.length) {
  console.log('\n⚠️ 有一边还没数据，等影子跑一会儿再来');
  process.exit(0);
}

/* ---------- 3. 交集窗口 ---------- */
const nimT = nim.map((x) => Number(x.t));
const ownT = own.map((x) => Number(x[0]));
let since = Math.max(Math.min(...nimT), Math.min(...ownT));
const until = Math.min(Math.max(...nimT), Math.max(...ownT));
const cap = Date.now() - HOURS * 3600e3;
if (cap > since) since = cap;
if (!(until > since)) {
  console.log(`\n⚠️ 两边没有重叠时段（影子 ${bj(Math.min(...nimT))}→${bj(Math.max(...nimT))}，`
    + `线上 ${bj(Math.min(...ownT))}→${bj(Math.max(...ownT))}）`);
  process.exit(0);
}
nim = nim.filter((x) => Number(x.t) >= since && Number(x.t) <= until);
const ownWin = own.filter((x) => Number(x[0]) >= since && Number(x[0]) <= until);
const chOf = {};
for (const x of ownWin) chOf[x[7]] = (chOf[x[7]] || 0) + 1;

console.log(`\n重叠窗口 ${bj(since)} → ${bj(until)}（${((until - since) / 60000).toFixed(0)} 分钟）`);
console.log(`  云信 ${nim.length} 条 | 鸡腿 ${nim.reduce((a, x) => a + (Number(x.v) || 0) * (Number(x.num) || 1), 0)}`);
console.log(`  线上 ${ownWin.length} 条  [${Object.entries(chOf).map(([k, v]) => k + ' ' + v).join(' / ') || '无'}]`);

/* ---------- 4. 对齐 ---------- */
const TOL = 10000;
const usedNim = new Set();
const res = { same: 0, numDiff: [], onlyOwn: [], byCh: {}, offs: [] };
for (const o of ownWin) {
  const [t, mid, , sn, , num] = o;
  let best = -1, bestD = Infinity;
  nim.forEach((n, i) => {
    if (usedNim.has(i)) return;
    if (Number(n.mid) !== Number(mid)) return;
    const d = Math.abs(Number(n.t) - Number(t));
    if (d <= TOL && d < bestD) { bestD = d; best = i; }
  });
  const ck = o[7] || '?';
  const bucket = (res.byCh[ck] = res.byCh[ck] || { own: 0, hit: 0 });
  bucket.own++;
  if (best < 0) { res.onlyOwn.push(o); continue; }
  usedNim.add(best);
  bucket.hit++;
  res.offs.push(Math.abs(Number(nim[best].t) - Number(t)));
  const n = nim[best];
  if (Number(n.num) === Number(num)) res.same++;
  else res.numDiff.push({ at: bj(t), mid, sn, own: num, nim: Number(n.num), g: n.g });
}
const onlyNim = nim.filter((_, i) => !usedNim.has(i));

/* ---------- 5. 输出 ---------- */
const pct = ownWin.length ? (res.same / ownWin.length * 100).toFixed(1) : '—';
console.log('\n================ 对账结果 ================');
console.log(`完全对上          ${res.same}  (${pct}% of 线上)`);
console.log(`份数不一致        ${res.numDiff.length}`);
console.log(`线上有、云信没有    ${res.onlyOwn.length}   ← 切之前必须是 0`);
console.log(`云信有、线上没有    ${onlyNim.length}   ← 多出来的，通常是我们更全`);

if (res.onlyOwn.length) {
  console.log('\n-- 线上有、云信漏掉的（前 15）--');
  for (const x of res.onlyOwn.slice(0, 15)) console.log(` ${bj(x[0])} mid=${x[1]} ${x[3]} ×${x[5]} ch=${x[7]}`);
}
if (res.numDiff.length) {
  console.log('\n-- 份数不一致（前 15）--');
  for (const x of res.numDiff.slice(0, 15)) console.log(` ${x.at} mid=${x.mid} ${x.sn} ${x.g} 线上=${x.own} 云信=${x.nim}`);
}
if (onlyNim.length) {
  console.log('\n-- 只有云信抓到（前 15）--');
  for (const x of onlyNim.slice(0, 15)) {
    console.log(` ${bj(x.t)} mid=${x.mid} ${x.sn} ${x.g} ×${x.num} v=${x.v || 0} 送礼uid=${x.sid || '无'}`);
  }
}

console.log('\n结论：' + (ownWin.length < 5
  ? `⚠️ 样本太小（线上只有 ${ownWin.length} 条），再跑一会儿`
  : (res.onlyOwn.length === 0 ? '✅ 云信覆盖线上现有链路，可以切' : `❌ 云信漏了 ${res.onlyOwn.length} 条，先查原因`)));

/* ---------- 6. 分房间覆盖率 / 时间偏差 ---------- */
const chRows = Object.entries(res.byCh).sort((a, b) => b[1].own - a[1].own);
if (chRows.length) {
  console.log('\n-- 分房间覆盖率（线上条数 → 云信对上）--');
  for (const [k, v] of chRows) {
    console.log(` ${k}  ${v.own} → ${v.hit}  ${(v.hit / v.own * 100).toFixed(0)}%`);
  }
}
if (res.offs.length) {
  const s = res.offs.slice().sort((a, b) => a - b);
  const med = s[Math.floor(s.length / 2)];
  console.log(`\n时间偏差（云信−线上）中位数 ${(med / 1000).toFixed(1)} 秒，`
    + `90 分位 ${(s[Math.floor(s.length * 0.9)] / 1000).toFixed(1)} 秒，最大 ${(s[s.length - 1] / 1000).toFixed(1)} 秒`);
}
const nimLegs = nim.reduce((a, x) => a + (Number(x.v) || 0) * (Number(x.num) || 1), 0);
const nimNoV = nim.filter((x) => !Number(x.v)).length;
console.log(`云信鸡腿合计 ${nimLegs.toLocaleString()}（无单价的 ${nimNoV} 条）`);
