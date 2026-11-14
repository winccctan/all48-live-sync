/**
 * 成员主页字段深挖：有没有「最后活跃时间 / 在线状态」类字段
 * 对每个 uid 打 home + home/small 的全部字段，凡是数字像时间戳的就翻译成北京时间。
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
  const { stdout } = await run('curl', ['-sS', '--noproxy', '*', '-m', '25', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8', '-H', 'appInfo: ' + appInfo, '-H', 'token: ' + TOKEN,
    '-H', 'pa: ' + PA, '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-d', JSON.stringify(body || {})], { maxBuffer: 16e6 });
  try { return JSON.parse(stdout); } catch { return { _raw: stdout.slice(0, 300) }; }
}
const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();
const TOKEN = process.env.POCKET48_TOKEN || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN');

const BJ = (n) => new Date(n + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const asTime = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  if (v > 1e12 && v < 4e12) return `  ← ${BJ(v)}`;
  if (v > 1e9 && v < 4e9) return `  ← ${BJ(v * 1000)}`;
  return '';
};
const MEMBERS = [
  ['曹可甜', 159711307],   // 今天 15:52–16:19 有消息，之后静默
  ['曾雪婷', 161808451],   // 18:28 连发四条翻牌
  ['温若其', 103679163],   // 对照
];
for (const [name, uid] of MEMBERS) {
  for (const path of ['/user/api/v1/user/info/home', '/user/api/v1/user/info/home/small']) {
    const d = await pc(path, { userId: uid });
    const c = d && d.content;
    console.log(`\n===== ${name}(${uid})  ${path}  status=${d && d.status}`);
    if (!c || typeof c !== 'object') { console.log('  content:', JSON.stringify(c).slice(0, 120)); continue; }
    const walk = (o, p = '') => {
      for (const [k, v] of Object.entries(o)) {
        const kp = p ? p + '.' + k : k;
        if (v && typeof v === 'object') { if (!Array.isArray(v)) walk(v, kp); else console.log(`  ${kp} = [${v.length}]`); continue; }
        if (typeof v === 'string' && v.length > 60) { console.log(`  ${kp} = <str ${v.length}>`); continue; }
        const t = asTime(v);
        console.log(`  ${kp} = ${v}${t}${/<time|active|login|online|status|live|state|utime|last/i.test(k) ? '   ★' : ''}`);
      }
    };
    walk(c);
  }
}
