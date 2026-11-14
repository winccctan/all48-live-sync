/**
 * 关注列表「排序参数」模糊测试（只读）
 * 目的：把 App 可能用来排「最近活跃」的入参掏出来 —— 服务端默认按 createAt 倒序，
 * 只要某个参数能把顺序换成别的（尤其跟房间活跃相关），那个参数就是我们要的开关。
 * 做法：同一份 token 连着打，记录 (条数, 顺序指纹, 首条 createAt)，与默认值对比。
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const API_BASE = 'https://pocketapi.48.cn';
let PA = '';
async function pc(path, body) {
  const { generatePa } = await import('./lib/pa.mjs');
  PA = PA || generatePa();
  const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
  const { stdout } = await run('curl', ['-sS', '--noproxy', '*', '-m', '20', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8', '-H', 'appInfo: ' + appInfo, '-H', 'token: ' + TOKEN,
    '-H', 'pa: ' + PA, '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-d', JSON.stringify(body || {})], { maxBuffer: 16e6 });
  try { return JSON.parse(stdout); } catch { return { _raw: stdout.slice(0, 200) }; }
}
const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();
const TOKEN = process.env.POCKET48_TOKEN || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN');
const h6 = (s) => createHash('md5').update(String(s)).digest('hex').slice(0, 6);

function sig(d) {
  const L = d && d.content && (d.content.list || (Array.isArray(d.content) ? d.content : null));
  if (!Array.isArray(L)) return { st: d && d.status, n: -1, order: '-', c0: '-' };
  const ids = L.map((x) => String((x && x.userInfo && x.userInfo.userId) || (x && x.userId) || ''));
  return {
    st: d.status, n: L.length,
    order: h6(ids.join(',')),
    c0: String((L[0] && L[0].createAt) || ''),
    head: ids.slice(0, 3).join(','),
  };
}

const P = '/user/api/v1/friendships/friends';
const base = sig(await pc(P, {}));
console.log('默认：', JSON.stringify(base));

console.log('\n--- 参数 fuzz（看顺序指纹/条数会不会变）---');
const params = [
  { sort: 1 }, { sort: 2 }, { sortType: 1 }, { sortType: 2 }, { sort: 3 },
  { order: 1 }, { orderBy: 'active' }, { orderBy: 'online' }, { type: 1 }, { type: 2 },
  { filter: 1 }, { active: 1 }, { online: 1 }, { isOnline: 1 }, { status: 1 },
  { onlineState: 1 }, { recent: 1 }, { orderByActive: 1 }, { byTime: 1 }, { byActive: 1 },
  { pageNo: 1, pageSize: 20, sort: 1 }, { pageNo: 1, sortType: 2 }, { next: 0, sort: 1 },
];
for (const body of params) {
  const s = sig(await pc(P, body));
  const diff = s.order !== base.order || s.n !== base.n;
  console.log(`${diff ? '★' : ' '} ${JSON.stringify(body).padEnd(34)} st=${s.st} n=${s.n} order=${s.order}${diff ? '  ← 变了' : ''}`);
}

console.log('\n--- 路径 fuzz（找第二个关注列表入口）---');
const paths = [
  '/user/api/v1/friendships/followers',
  '/user/api/v1/friendships/friends/list',
  '/user/api/v1/friendships/friends/all',
  '/user/api/v1/friendships/friends/new',
  '/user/api/v1/friendships/friends/recent',
  '/user/api/v1/friendships/friends/online',
  '/user/api/v1/friendships/attention/list',
  '/user/api/v1/friendships/my',
  '/user/api/v1/friendships/star/list',
  '/user/api/v1/attention/list',
  '/user/api/v1/attention',
];
for (const p of paths) {
  const d = await pc(p, {});
  const c = d && d.content;
  const shape = Array.isArray(c) ? `array[${c.length}]` : (c && typeof c === 'object' ? Object.keys(c).slice(0, 6).join(',') : String(c).slice(0, 30));
  console.log(`${d && d.status === 200 ? '★' : ' '} ${p.padEnd(44)} st=${d && d.status} ${shape}`);
}
