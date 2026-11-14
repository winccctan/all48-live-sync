/**
 * 头像/状态可见信号探针（只读，脱敏）
 * =====================================================
 * 站长线索（2026-11-14）：成员「打开 App / 上下线」时，关注列表里的
 * 头像/头像框/角标可能跟着变（会动）。若成立 ⇒ 不需要云信权限，
 * 纯轮询头像字段就能推断在线态，绕开 403。
 *
 * 做法：拉一批可能含成员/头像/状态字段的公开接口，扫描返回里
 *   avatar/av/img/head/face/photo/portrait/url + online/status/active/state
 * 两类键；对在线成员 vs 离线成员对比这些字段的【值 hash 与长度】。
 * 🔴 绝不打印头像 URL 原文、uid、nickname 全文 —— 只打印字段路径、值长度、hash8。
 *
 * 运行：
 *   node probe-avatar-signal.mjs                  # 用 nim-sync.env 的 POCKET48_TOKEN
 *   node probe-avatar-signal.mjs --poll 3 40      # 连续 3 轮、每轮隔 40s（看字段会不会变）
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/* 🔴 本沙箱里 node 原生 fetch 打 pocketapi.48.cn 会 TLS 断（代理/直连都不稳），
   只有 curl --noproxy '*' 直连稳定（2026-11-13 起反复验证）。这里走 curl 直连，
   与 client.mjs / probe-presence-packets.mjs 同一套 appInfo + pa + token 头。 */
const API_BASE = 'https://pocketapi.48.cn';
let PA = '';
async function pocketCurl(path, body, token) {
  const { generatePa } = await import('./lib/pa.mjs');
  PA = PA || generatePa();
  const appInfo = JSON.stringify({
    vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
    appVersion: '7.0.41', appBuild: '24011601',
    osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
  });
  const { stdout } = await run('curl', [
    '-sS', '--noproxy', '*', '-m', '20', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8',
    '-H', 'appInfo: ' + appInfo,
    '-H', 'token: ' + token,
    '-H', 'pa: ' + PA,
    '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-H', 'Accept-Language: zh-Hans-CN;q=1',
    '-d', JSON.stringify(body || {}),
  ], { maxBuffer: 8e6 });
  return JSON.parse(stdout);
}

const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();

const TOKEN = process.env.POCKET48_TOKEN
  || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN')
  || pick(env(ROOT + 'fb.env'), 'POCKET48_TOKEN');

if (!TOKEN) { console.error('缺 POCKET48_TOKEN（nim-sync.env / fb.env）'); process.exit(1); }

const ARGS = process.argv.slice(2);
const opt = (k, d) => { const i = ARGS.indexOf('--' + k); return i >= 0 ? ARGS[i + 1] : d; };
const POLL_ROUNDS = Number(opt('poll', 0));   // 0 = 单轮
const POLL_GAP = Number(opt('gap', 40)) * 1000;

const AV_RE = /avatar|^av$|img|head|face|photo|portrait|thumb|icon|pic|url/i;
const ST_RE = /online|status|active|state|login|logout|presence|on.?line|live/i;

/* 递归收集所有叶子字段的 {路径, 值}，按对象数组下标聚合 */
function collect(obj, path = '', out = []) {
  // 叶子（非对象）必须在这里 push，否则 out 永远空 —— 上一版漏了这行导致叶子=0
  if (obj == null || typeof obj !== 'object') { out.push({ path, value: obj }); return out; }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collect(v, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    collect(v, p, out);
  }
  return out;
}

/* 把一批返回压成「字段名 → 值签名集合」：只记 key 路径去掉下标后的形状 + 值 hash/长度 */
function summarize(label, data) {
  const leaves = collect(data);
  const buckets = new Map();   // 归一化字段路径 -> Set(签名)
  for (const { path, value } of leaves) {
    if (value == null || value === '') continue;
    const norm = path.replace(/\[\d+\]/g, '[]');   // 去下标，只看形状
    const isAv = AV_RE.test(norm);
    const isSt = ST_RE.test(norm);
    if (!isAv && !isSt) continue;
    const v = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const h = createHash('md5').update(v).digest('hex').slice(0, 8);
    const sig = `${typeof value}:${v.length}:#${h}`;
    if (!buckets.has(norm)) buckets.set(norm, new Set());
    buckets.get(norm).add(sig);
  }
  return { label, buckets, n: leaves.length };
}

/* 判断「这个返回里有没有任何 online/status 是真在线」—— 用来分组在线/离线样本 */
function findOnlineFlags(data, path = '', out = []) {
  if (data == null || typeof data !== 'object') return out;
  if (Array.isArray(data)) { data.forEach((v, i) => findOnlineFlags(v, `${path}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(data)) {
    const p = path ? `${path}.${k}` : k;
    if (ST_RE.test(k) && typeof v !== 'object' && v !== '' && v != null) out.push({ path: p, key: k, value: v });
    findOnlineFlags(v, p, out);
  }
  return out;
}

async function scanOnce(tag) {
  console.log(`\n======== ${tag} ========`);
  // 只探「可通且可能含成员/头像」的路径；每个都只打 status + 顶层形状，不 dump 内容
  // 🔴 路径来自 qqtools v6 接口文档 + 11-13 扫描记录里确认可通的那些，不猜。
  const probes = [
    ['/user/api/v1/client/update/group_team_star', { version: 0 }],   // 全团资料：starInfo[] 含头像/utime
    ['/user/api/v1/user/info/home', { userId: 1 }],                    // 成员主页：30 个字段
    ['/user/api/v1/user/info/home/small', { userId: 1 }],              // 成员主页精简
    ['/user/api/v1/friendships/friends/id', {}],                       // 好友/关注 id
    ['/im/api/v1/im/userinfo', {}],                                    // 自己的 NIM 凭证（对照）
  ];
  for (const [path, body] of probes) {
    try {
      const d = await pocketCurl(path, body, TOKEN);
      const content = d && d.content !== undefined ? d.content : d;
      const top = content && typeof content === 'object'
        ? Object.keys(content).slice(0, 10).join(',')
        : String(content).slice(0, 40);
      const s = summarize(path, content);
      const flags = findOnlineFlags(content);
      console.log(`\n[${path}] status=${d && d.status} 顶层=[${top}] 叶子=${s.n}`);
      if (!s.buckets.size) { console.log('   （无 avatar/status 类字段）'); continue; }
      const rows = [...s.buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [norm, sigs] of rows) {
        const uniq = [...sigs].join(' | ');
        console.log(`   ${AV_RE.test(norm) && ST_RE.test(norm) ? '★' : (AV_RE.test(norm) ? '▣' : '◇')} ${norm}`);
        console.log(`       值签名(${sigs.size}种): ${uniq.slice(0, 160)}${uniq.length > 160 ? '…' : ''}`);
      }
      if (flags.length) {
        console.log(`   ◇ status/online 类标量 ${flags.length} 个，样例(去重值):`);
        const seenVal = new Set();
        for (const f of flags) {
          const sv = `${f.key}=${String(f.value).slice(0, 30)}`;
          if (seenVal.has(sv)) continue; seenVal.add(sv);
          console.log(`       ${sv}   @ ${f.path.replace(/\[\d+\]/g, '[]')}`);
          if (seenVal.size >= 8) break;
        }
      }
    } catch (e) {
      console.log(`\n[${path}] 失败：${String((e && e.message) || e).slice(0, 90)}`);
    }
  }
}

(async () => {
  console.log('头像/状态可见信号探针（只读；只打印字段名/值长度/hash，不打 URL 与 uid）');
  if (POLL_ROUNDS > 0) {
    for (let r = 1; r <= POLL_ROUNDS; r++) {
      await scanOnce(`第 ${r}/${POLL_ROUNDS} 轮`);
      if (r < POLL_ROUNDS) { console.log(`\n…隔 ${POLL_GAP / 1000}s 后再拉，对比字段签名是否变化…`); await new Promise(s => setTimeout(s, POLL_GAP)); }
    }
  } else {
    await scanOnce('单轮快照（加 --poll 3 40 可连续拉看变化）');
  }
  console.log('\n判读：★ = 既像头像又像状态（最可疑）；▣ = 头像类；◇ = 状态类。');
  console.log('      若某头像字段在多轮间「值签名变了」⇒ 它随在线态动，可做轮询信号源。');
  console.log('      若所有 ▣ 字段多轮恒定 ⇒ 头像不随在线变，此路不通。');
})();
