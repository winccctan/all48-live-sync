#!/usr/bin/env node
/**
 * 云信影子模式对账器（demo 并行验证用，不写任何库）
 * =============================================================
 * 用途：把「云信直连抓到的礼物」和「牙牙 gnz.hk 已发布的礼物」逐条对齐，
 *      证明云信这条通道是否真的能拿全。对上了才切生产。
 *
 * 输入：
 *   · 云信影子数据 nim-state/dry-YYYYMMDD.jsonl（DRY=1 时 OUT 输出）
 *   · 牙牙公开接口 GET https://gnz.hk/api/vote/events?limit=200&all=1
 *
 * 判定：
 *   · onlyNim   = 云信有、牙牙没有 → 可能是我们更全（好事）也可能是解析错（要查）
 *   · onlyGnz   = 牙牙有、云信没有 → 真漏（要修）
 *   · numDiff   = 两边都有但份数不同 → 连刷份数解析差异（重点看）
 *
 * 用法：node nim-shadow-diff.mjs [--hours=2] [--day=20261111]
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname);
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)=?(.*)$/.exec(a);
    return m ? [m[1], m[2] || true] : [a, true];
  })
);
const HOURS = Number(argv.hours || 3);
const DAY = String(argv.day || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, ''));

const bj = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' ');

/* ---------------- 1. 读云信影子数据 ---------------- */
const stateDir = resolve(ROOT, 'nim-state');
const files = existsSync(stateDir)
  ? readdirSync(stateDir).filter((f) => /^dry-\d{8}\.jsonl$/.test(f))
  : [];
let nim = [];
for (const f of files) {
  const txt = readFileSync(resolve(stateDir, f), 'utf8');
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { nim.push(JSON.parse(line)); } catch { /* 半行忽略 */ }
  }
}
const since = Date.now() - HOURS * 3600e3;
nim = nim.filter((x) => Number(x.t) >= since);
console.log(`云信影子：${nim.length} 条（近 ${HOURS} 小时，来自 ${files.length} 个文件）`);
if (nim.length) {
  const bySrc = { 0: 0, 1: 0 };
  for (const x of nim) bySrc[x.src] = (bySrc[x.src] || 0) + 1;
  console.log(`  房间(src0) ${bySrc[0] || 0} 条 / 直播(src1) ${bySrc[1] || 0} 条`);
  console.log(`  时间范围 ${bj(Math.min(...nim.map((x) => x.t)))} → ${bj(Math.max(...nim.map((x) => x.t)))}`);
  const legs = nim.reduce((a, x) => a + (Number(x.v) || 0) * (Number(x.num) || 1), 0);
  console.log(`  鸡腿合计 ${legs}`);
}

/* ---------------- 2. 拉牙牙已发布的礼物 ---------------- */
async function fetchGnz(limit = 200) {
  const u = `https://gnz.hk/api/vote/events?limit=${limit}&all=1`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0', accept: 'application/json' } });
  const t = await r.text();
  if (t.trim().startsWith('<')) throw new Error('gnz 返回 HTML（可能被 WAF 拦）');
  const j = JSON.parse(t);
  return (j.content && j.content.items) || j.items || [];
}
let gnz = [];
try {
  gnz = await fetchGnz(200);
} catch (e) {
  console.error('拉 gnz 失败：' + e.message);
}
gnz = gnz.filter((x) => Number(x.time || x.t || 0) >= since);
console.log(`\n牙牙已发布：${gnz.length} 条（近 ${HOURS} 小时）`);

/* ---------------- 3. 归一化后对齐 ----------------
 * 云信侧：{ t, num, gid, g(礼物名), mid(成员), v(单价), src }
 * 牙牙侧：{ time, giftNum, giftId, giftName, memberId, source }
 * 对齐键：成员 + 礼物 + 时间（±8 秒）—— 两边时间戳来源不同，必须给容差。
 */
const near = (a, b, ms = 8000) => Math.abs(Number(a) - Number(b)) <= ms;

const matched = new Set();
const report = { same: 0, numDiff: [], onlyNim: [], onlyGnz: [] };

for (const g of gnz) {
  const gt = Number(g.time || g.t || 0);
  const gmid = String(g.memberId || g.member || '');
  const ggid = String(g.giftId || g.gid || '');
  const gnum = Number(g.giftNum ?? g.num ?? 1);
  const hit = nim.find((n, i) => {
    if (matched.has(i)) return false;
    if (String(n.mid) !== gmid) return false;
    if (ggid && String(n.gid) !== ggid) return false;
    return near(n.t, gt);
  });
  if (!hit) { report.onlyGnz.push(g); continue; }
  matched.add(nim.indexOf(hit));
  if (Number(hit.num) === gnum) report.same++;
  else report.numDiff.push({ member: g.memberName || gmid, gift: g.giftName || ggid, gnz: gnum, nim: Number(hit.num), at: bj(gt) });
}
nim.forEach((n, i) => { if (!matched.has(i)) report.onlyNim.push(n); });

/* ---------------- 4. 输出 ---------------- */
console.log('\n================ 对账结果 ================');
console.log(`完全一致      ${report.same}`);
console.log(`份数不一致    ${report.numDiff.length}`);
console.log(`只有云信有    ${report.onlyNim.length}`);
console.log(`只有牙牙有    ${report.onlyGnz.length}   ← 这个必须是 0 才能切`);

if (report.numDiff.length) {
  console.log('\n-- 份数不一致（前 15）--');
  for (const x of report.numDiff.slice(0, 15)) console.log(` ${x.at} ${x.member} ${x.gift} 牙牙=${x.gnz} 云信=${x.nim}`);
}
if (report.onlyGnz.length) {
  console.log('\n-- 牙牙有、云信没抓到的（前 15）--');
  for (const x of report.onlyGnz.slice(0, 15)) {
    console.log(` ${bj(x.time || x.t)} ${x.memberName || x.memberId} ${x.giftName || x.giftId} ×${x.giftNum ?? x.num} source=${x.source}`);
  }
}
if (report.onlyNim.length) {
  console.log('\n-- 只有云信抓到（前 15）--');
  for (const x of report.onlyNim.slice(0, 15)) console.log(` ${bj(x.t)} ${x.sn} ${x.g} ×${x.num} src=${x.src} v=${x.v}`);
}

const verdict = report.onlyGnz.length === 0 && nim.length > 0
  ? '✅ 云信覆盖牙牙，可以切'
  : (nim.length === 0 ? '⚠️ 云信还没抓到数据，继续观察' : '❌ 云信有漏，不能切');
console.log('\n结论：' + verdict);
