/**
 * 一次性：摸清 friendships/friends 的完整字段 + 分页 + /id 接口内容
 * 只读、脱敏（uid/昵称只打 hash 与长度，URL 只打 host+长度）
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
const h8 = (v) => createHash('md5').update(String(v)).digest('hex').slice(0, 6);
const sig = (v) => {
  if (v == null) return 'null';
  if (typeof v === 'object') return 'obj' + (Array.isArray(v) ? '[' + v.length + ']' : '{' + Object.keys(v).length + '}');
  const s = String(v);
  if (/^https?:\/\//.test(s)) return 'url:' + (s.match(/^https?:\/\/([^/]+)/) || [, '?'])[1] + '/' + s.length + '#' + h8(s);
  if (/^\d{6,}$/.test(s)) return 'id' + s.length + '#' + h8(s);
  return s.length > 20 ? s.slice(0, 8) + '…' + s.length + '#' + h8(s) : s;
};

const base = await pc('/user/api/v1/friendships/friends', {});
console.log('顶层:', Object.keys(base), 'status=', base.status);
const c = base.content;
console.log('content 键:', Object.keys(c));
for (const k of Object.keys(c)) if (typeof c[k] !== 'object') console.log(`  ${k} = ${c[k]}`);
console.log('\n第一条完整结构：');
const it0 = c.list[0];
for (const [k, v] of Object.entries(it0)) {
  if (k === 'userInfo') { console.log('  userInfo:'); for (const [k2, v2] of Object.entries(v)) console.log(`     ${k2} = ${sig(v2)}  <${v2 === null ? 'null' : typeof v2}>`); }
  else console.log(`  ${k} = ${sig(v)}  <${typeof v}>`);
}
console.log('\ncreateAt 全量(排序线索):', c.list.map(x => x.createAt).join(','));
console.log('myFollower 分布:', JSON.stringify(c.list.reduce((a, x) => (a[x.myFollower] = (a[x.myFollower] || 0) + 1, a), {})));

console.log('\n--- 分页测试 ---');
for (const body of [{ pageNo: 1, pagesize: 50 }, { pageNo: 2, pagesize: 20 }, { pageSize: 50 }, { nextId: 1 }]) {
  const r = await pc('/user/api/v1/friendships/friends', body);
  const n = r.content && r.content.list ? r.content.list.length : -1;
  const first = n > 0 ? String((r.content.list[0].userInfo || {}).userId || '').slice(-4) : '';
  console.log(JSON.stringify(body), '→ 条数', n, '首条尾号', first, '顶层', r.content ? Object.keys(r.content).join(',') : '');
}

console.log('\n--- /friendships/friends/id ---');
const idd = await pc('/user/api/v1/friendships/friends/id', {});
const d = idd.content && idd.content.data;
console.log('data 类型:', Array.isArray(d) ? `array[${d.length}]` : typeof d);
if (Array.isArray(d)) console.log('前 5 条:', d.slice(0, 5).map(x => JSON.stringify(x).slice(0, 60)).join(' | '));
else if (d && typeof d === 'object') { console.log('键:', Object.keys(d)); for (const [k, v] of Object.entries(d)) console.log(`  ${k}:`, Array.isArray(v) ? `array[${v.length}] 样例 ${String(v[0]).slice(0, 30)}` : sig(v)); }

console.log('\n--- 其它可能的「关注列表」入口 ---');
for (const p of ['/user/api/v1/friendships/follow/list', '/user/api/v1/friendships/follows', '/user/api/v1/star/follow/list', '/user/api/v1/user/follow/list']) {
  const r = await pc(p, {});
  console.log(p, '→ status', r.status, 'content', r.content ? (Array.isArray(r.content) ? 'array' : Object.keys(r.content).join(',')) : '-');
}
