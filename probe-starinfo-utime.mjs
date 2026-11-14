/**
 * 全团资料接口（group_team_star）有没有「成员资料最后更新时间 utime」这类动态时间戳？
 * 若有 ⇒ 这是服务端唯一能拿到的「她最近动过 App」的间接证据（换头像/改签名/开播设置）。
 */
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const API_BASE = 'https://pocketapi.48.cn';
let PA = '';
async function pc(path, body) {
  const { generatePa } = await import('./lib/pa.mjs');
  PA = PA || generatePa();
  const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
  const { stdout } = await run('curl', ['-sS', '--noproxy', '*', '-m', '40', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8', '-H', 'appInfo: ' + appInfo, '-H', 'token: ' + TOKEN,
    '-H', 'pa: ' + PA, '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-d', JSON.stringify(body || {})], { maxBuffer: 64e6 });
  try { return JSON.parse(stdout); } catch { return { _raw: stdout.slice(0, 300) }; }
}
const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();
const TOKEN = process.env.POCKET48_TOKEN || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN');
const BJ = (n) => new Date(n + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const isTs = (v) => typeof v === 'number' && ((v > 1e12 && v < 4e12) || (v > 1e9 && v < 4e9));
const bjOf = (v) => BJ(v > 4e9 ? v : v * 1000);

const d = await pc('/user/api/v1/client/update/group_team_star', { version: 0 });
console.log('status=', d.status, 'content 键=', d.content && typeof d.content === 'object' ? Object.keys(d.content).join(',') : typeof d.content);
const c = d.content;
if (!c) process.exit(0);

// 找到成员数组
let arr = null, arrKey = '';
const look = (o, p = '') => {
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v) && v.length > 10 && typeof v[0] === 'object') { if (!arr || v.length > arr.length) { arr = v; arrKey = p ? p + '.' + k : k; } }
    else if (v && typeof v === 'object' && !Array.isArray(v)) look(v, p ? p + '.' + k : k);
  }
};
look(c);
console.log('成员数组=', arrKey, '条数=', arr && arr.length);
if (!arr) process.exit(0);

/* 1) 字段清点：哪些字段是时间戳 */
const tsKeys = new Set(), allKeys = new Set();
for (const it of arr) for (const [k, v] of Object.entries(it)) { allKeys.add(k); if (isTs(v)) tsKeys.add(k); }
console.log('全部字段:', [...allKeys].join(','));
console.log('时间戳类字段:', [...tsKeys].join(',') || '（无）');

/* 2) 对每个时间戳字段：值分布 + 最近的时间 */
for (const k of tsKeys) {
  const vals = arr.map(x => x[k]).filter(isTs).sort((a, b) => b - a);
  const uniq = new Set(vals);
  console.log(`\n★ ${k}: ${vals.length} 个值 / ${uniq.size} 种；最新=${bjOf(vals[0])}  最旧=${bjOf(vals[vals.length - 1])}`);
  console.log('   最新 8 个:', vals.slice(0, 8).map(bjOf).join(' | '));
}

/* 3) 重点：今天有变化的人数（按每个时间戳字段） */
const todayBJ = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
for (const k of tsKeys) {
  const n = arr.filter(x => isTs(x[k]) && bjOf(x[k]).slice(0, 10) === todayBJ).length;
  if (n) console.log(`   ↳ ${k}: 今天(${todayBJ}) 有 ${n} 人`);
}

/* 4) 看两个样本的完整字段 */
for (const uid of [159711307, 161808451]) {
  const it = arr.find(x => x.userId === uid || x.starId === uid || x.id === uid);
  console.log(`\n--- 样本 ${uid}:`, it ? Object.entries(it).map(([k, v]) => `${k}=${typeof v === 'string' && v.length > 40 ? '<str' + v.length + '>' : v}${isTs(v) ? '(' + bjOf(v).slice(5, 16) + ')' : ''}`).join('  ') : '未找到');
}
