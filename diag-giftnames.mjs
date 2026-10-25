/**
 * 诊断：今天所有已结束场次的回放弹幕里，到底出现过哪些礼物名？
 * 目的：确认「弦月回响」是否真的缺席，还是只是名字写法不同被解析器漏掉。
 */
import { postJson, fetchText } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const BJ = 8 * 3600 * 1000;
const SINCE = Date.UTC(2026, 9, 24, 0, 0, 0) - BJ; // 北京 2026-10-24 00:00
const CONC = Math.max(1, Number(process.env.CONC || 10));

const RE_LINE = /^\[(\d+):(\d+):([\d.]+)\]([^\t]*)\t(.*)$/;
const RE_GIFT = /送给\s*(\S+?)\s*(\d+)\s*个\s*(.+)$/;

async function collect() {
  const out = [];
  let next = '0';
  for (let p = 0; p < 30; p++) {
    const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 3 });
    const c = (r && r.content) || {};
    const list = c.liveList || [];
    if (!list.length) break;
    let stop = false;
    for (const x of list) {
      const ctime = Number(x.ctime) || 0;
      if (ctime < SINCE) { stop = true; break; }
      out.push({ liveId: String(x.liveId || ''), nick: String((x.userInfo && x.userInfo.nickname) || ''), ctime });
    }
    if (stop) break;
    const nx = String(c.next || '0');
    if (!nx || nx === '0' || nx === String(next)) break;
    next = nx;
  }
  const seen = new Set();
  return out.filter((s) => s.liveId && !seen.has(s.liveId) && seen.add(s.liveId));
}

const gift = new Map();   // 礼物名 → 条数
const perLive = [];       // 每场：昵称 + 礼物名分布
let idx = 0, done = 0;

async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= sessions.length) return;
    const s = sessions[i];
    let one;
    try { one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: s.liveId }, { token: TOKEN, retries: 2 })).content || {}; }
    catch { done++; continue; }
    const url = one.msgFilePath;
    if (!url) { done++; continue; }
    let text = '';
    try { text = await fetchText(url, { timeout: 40000 }); } catch { done++; continue; }
    const local = new Map();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const m = RE_LINE.exec(line);
      if (!m) continue;
      const g = RE_GIFT.exec(m[5]);
      if (!g) continue;
      const name = g[3].trim();
      gift.set(name, (gift.get(name) || 0) + 1);
      local.set(name, (local.get(name) || 0) + 1);
    }
    perLive.push({ nick: s.nick, gifts: local });
    done++;
  }
}

const sessions = await collect();
console.log(`候选场次 ${sessions.length}`);
await Promise.all(Array.from({ length: Math.min(CONC, sessions.length) }, worker));

console.log(`\n=== 全部礼物名（${gift.size} 种）按条数排序 ===`);
for (const [n, c] of [...gift.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(c).padStart(5)}  ${n}`);

console.log('\n=== 含「弦 / 回 / 响 / 月」的行内礼物名 ===');
for (const [n, c] of gift.entries()) if (/弦|回响|月/.test(n)) console.log(`  ${c}  ${n}`);

console.log('\n=== 各场礼物名（只列含弦/月/回响的） ===');
for (const p of perLive) {
  const hit = [...p.gifts.entries()].filter(([n]) => /弦|月|回响/.test(n));
  if (hit.length) console.log(`  ${p.nick}: ${hit.map(([n, c]) => n + '×' + c).join(' ')}`);
}
console.log(`\n完成 ${done}/${sessions.length} 场`);
