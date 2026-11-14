/* 定位漏采：同一场次的逐笔明细（时间/人/礼物/数量/通道），
 * 看漏的是「整段漏」还是「同款连送被去重」。 */
import fs from 'fs';
const WORKER = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/';
const env = fs.readFileSync(WORKER + '.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOK = pick('LV_TOKEN');
const BASE = 'https://all48-archive.yqz-tansy.workers.dev';
const liveId = process.argv[2] || '1328468207704281088';
const watch = process.argv[3] || '';

const r = await fetch(`${BASE}/api/lv/all?from=20261112&to=20261115`, { headers: { 'x-lv-token': TOK } });
const d = await r.json();
const sidNum = String(Number(liveId));
const rows = (d.items || []).filter((x) => Array.isArray(x) && Number(x[7]) === 2 && String(x[2]) === sidNum);
const chs = {};
for (const x of rows) chs[String(x[8] || '')] = (chs[String(x[8] || '')] || 0) + 1;
console.log(`场次 ${liveId} 行 ${rows.length} 通道 ${JSON.stringify(chs)}`);

const t = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
const pick1 = rows.filter((x) => !watch || String(x[3]).includes(watch));
console.log(`\n${watch ? '筛选「' + watch + '」' : '全部'}：${pick1.length} 笔`);
for (const x of pick1.slice(0, 60)) {
  console.log(`  ${t(x[0])} ${String(x[3]).slice(0, 14).padEnd(16)} ${String(x[4]).padEnd(12)} ×${String(x[5]).padEnd(4)} v=${x[6]} ch=${x[8] || '-'} t=${x[0]}`);
}
/* 同一毫秒的同款同数量（会被 lvKey 去重） */
const key = (x) => x[0] + '|' + x[1] + '|' + x[4] + '|' + x[5] + '|' + x[7];
const seen = new Map();
for (const x of rows) {
  const k = key(x);
  seen.set(k, (seen.get(k) || 0) + 1);
}
const dup = [...seen.entries()].filter(([, c]) => c > 1);
console.log(`\n潜在被去重的重复键 ${dup.length} 组：`, dup.slice(0, 5));
