/**
 * 关注列表结构探针（只读，脱敏）
 * ============================================================
 * 目的（2026-11-14 站长线索）：不走云信服务端，只靠「关注列表」这条业务接口
 * 看能不能读出在线/活跃特征。要回答三件事：
 *   1) 关注列表接口到底返回哪些字段（有没有 sort / weight / online / active 类）
 *   2) 同一批成员多轮拉取时，哪些字段的【值】会变、哪些字段的【位置】会变
 *   3) 服务端返回的数组顺序，和 App 里看到的排序是不是一回事
 *
 * 🔴 脱敏：uid/昵称只打 hash 与长度，头像只打 host + 长度 + hash，绝不打明文。
 *
 * 用法：
 *   node probe-followlist.mjs                    # 结构快照（各接口全字段名/类型）
 *   node probe-followlist.mjs --poll 6 30        # 6 轮、每轮隔 30s，对比值/顺序变化
 *   node probe-followlist.mjs --full             # 额外 dump 单条样本的全部字段值（仍脱敏）
 */
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const API_BASE = 'https://pocketapi.48.cn';
let PA = '';

/* 本沙箱 node 原生 fetch 打 pocketapi 不稳，统一走 curl --noproxy '*' 直连 */
async function pocketCurl(path, body, token) {
  const { generatePa } = await import('./lib/pa.mjs');
  PA = PA || generatePa();
  const appInfo = JSON.stringify({
    vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
    appVersion: '7.0.41', appBuild: '24011601',
    osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
  });
  const { stdout } = await run('curl', [
    '-sS', '--noproxy', '*', '-m', '25', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8',
    '-H', 'appInfo: ' + appInfo,
    '-H', 'token: ' + token,
    '-H', 'pa: ' + PA,
    '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-H', 'Accept-Language: zh-Hans-CN;q=1',
    '-d', JSON.stringify(body || {}),
  ], { maxBuffer: 16e6 });
  try { return JSON.parse(stdout); } catch { return { _raw: stdout.slice(0, 200) }; }
}

const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();
const TOKEN = process.env.POCKET48_TOKEN
  || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN')
  || pick(env(ROOT + 'fb.env'), 'POCKET48_TOKEN');
if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }

const ARGS = process.argv.slice(2);
const opt = (k, d) => { const i = ARGS.indexOf('--' + k); return i >= 0 ? ARGS[i + 1] : d; };
const ROUNDS = Number(opt('poll', 0));
const GAP = Number(opt('gap', 30)) * 1000;
const FULL = ARGS.includes('--full');
const LOG = ROOT + 'logs/followlist-probe.jsonl';

const h8 = (v) => createHash('md5').update(String(v)).digest('hex').slice(0, 8);

/* 值 → 脱敏短签名（同时用于「这轮和上轮比有没有变」） */
function sig(v) {
  if (v == null) return 'null';
  if (typeof v === 'object') return 'obj:' + Object.keys(v).length + ':#' + h8(JSON.stringify(v));
  const s = String(v);
  if (/^https?:\/\//.test(s)) {
    const host = (s.match(/^https?:\/\/([^/]+)/) || [, '?'])[1];
    return `url:${host}/${s.length}:#${h8(s).slice(0, 6)}`;
  }
  if (/^\d{6,}$/.test(s)) return `id:${s.length}:#${h8(s).slice(0, 6)}`;   // uid 一律脱敏
  return s.length > 24 ? `${s.slice(0, 6)}…${s.length}:#${h8(s)}` : s;
}

/* 找数组：content 里最长的那个对象数组 = 成员列表 */
function findList(content) {
  if (Array.isArray(content)) return { key: '(root)', arr: content };
  if (!content || typeof content !== 'object') return null;
  let best = null;
  for (const [k, v] of Object.entries(content)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
      if (!best || v.length > best.arr.length) best = { key: k, arr: v };
    }
    // 一层嵌套（如 {userInfos:{list:[]}}）
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2) && v2.length && typeof v2[0] === 'object') {
          if (!best || v2.length > best.arr.length) best = { key: k + '.' + k2, arr: v2 };
        }
      }
    }
  }
  return best;
}

const CANDIDATES = [
  '/user/api/v1/friendships/friends',
  '/user/api/v2/friendships/friends',
  '/user/api/v1/friendships/friends/id',
];

/* 抓一次，返回 {path, status, err, keys, listKey, arr} */
async function fetchList(path) {
  const d = await pocketCurl(path, {}, TOKEN);
  const out = { path, status: d && d.status, message: d && (d.message || d.msg), err: d && d.errorCode };
  const content = d && d.content !== undefined ? d.content : d;
  out.contentKeys = content && typeof content === 'object' && !Array.isArray(content) ? Object.keys(content) : [];
  const L = findList(content);
  if (L) { out.listKey = L.key; out.arr = L.arr; }
  return out;
}

/* 结构：字段名 → 出现次数 / 类型 / 值签名样本数 */
function shape(arr) {
  const m = new Map();
  for (const it of arr) {
    for (const [k, v] of Object.entries(it || {})) {
      if (!m.has(k)) m.set(k, { n: 0, types: new Set(), sigs: new Set() });
      const e = m.get(k);
      e.n++; e.types.add(v === null ? 'null' : typeof v); e.sigs.add(sig(v));
    }
  }
  return m;
}

/* 每条记录的身份键：优先 userId/starId/uid */
function idOf(it) {
  for (const k of ['userId', 'starId', 'uid', 'id', 'toUserId']) if (it[k] != null) return String(it[k]);
  if (it.userInfo) for (const k of ['userId', 'starId', 'uid', 'id']) if (it.userInfo[k] != null) return String(it.userInfo[k]);
  return null;
}

async function snapshot(tag) {
  const rows = [];
  for (const p of CANDIDATES) {
    try { rows.push(await fetchList(p)); } catch (e) { rows.push({ path: p, status: 'ERR', message: String(e.message || e).slice(0, 80) }); }
  }
  console.log(`\n===== ${tag} =====`);
  for (const r of rows) {
    console.log(`\n[${r.path}] status=${r.status}${r.err ? ' err=' + r.err : ''}${r.message ? ' msg=' + String(r.message).slice(0, 40) : ''}`);
    if (!r.arr) { console.log(`   content 键=[${(r.contentKeys || []).join(',')}]（无可解析数组）`); continue; }
    console.log(`   列表键=${r.listKey}  条数=${r.arr.length}`);
    const m = shape(r.arr);
    const sorted = [...m.entries()].sort((a, b) => b[1].n - a[1].n);
    for (const [k, e] of sorted) {
      const partial = e.n < r.arr.length ? ` ⚠️${e.n}/${r.arr.length}条有` : '';
      const varying = e.sigs.size > 1 || /status|online|active|sort|weight|time|time|utime|last|state|live/i.test(k);
      const star = /online|active|status|sort|weight|last|login|utime|state|live/i.test(k) ? '★' : ' ';
      console.log(`   ${star} ${k}: ${[...e.types].join('|')} 值形态${e.sigs.size}种${partial}`);
      if (varying) {
        const sample = [...e.sigs].slice(0, 4).join(' , ');
        console.log(`        ${sample}${e.sigs.size > 4 ? ' …' : ''}`);
      }
    }
    // 顺序快照：只打 index + uid hash，供后续对比
    const order = r.arr.map((it, i) => `${i}:${idOf(it) ? '#' + h8(idOf(it)) : '?'}`);
    console.log(`   顺序(前12)=${order.slice(0, 12).join(' ')}`);
  }
  return rows;
}

(async () => {
  console.log('关注列表结构探针（只读 / 脱敏）  token=已读取');
  const all = [];
  if (!ROUNDS) {
    const rows = await snapshot('单轮结构快照');
    if (FULL) {
      console.log('\n----- 全字段样本（第 1 条，已脱敏） -----');
      const a = rows.find(r => r.arr && r.arr.length);
      if (a) for (const [k, v] of Object.entries(a.arr[0])) console.log(`  ${k} = ${sig(v)}   <${v === null ? 'null' : typeof v}>`);
    }
    return;
  }
  /* 多轮：跟踪「值签名变化」与「位置变化」 */
  let prev = null;
  for (let i = 1; i <= ROUNDS; i++) {
    const t = new Date().toISOString().slice(11, 19);
    const r = await fetchList('/user/api/v1/friendships/friends');
    const arr = r.arr || [];
    const cur = new Map();
    arr.forEach((it, idx) => {
      const id = idOf(it); if (!id) return;
      cur.set(id, { idx, it });
    });
    const changedKeys = new Map();  // key -> [ {id, from, to} ]
    let moved = [];
    if (prev) {
      for (const [id, { idx, it }] of cur) {
        const p = prev.get(id); if (!p) { moved.push(`+${'#' + h8(id)}`); continue; }
        if (p.idx !== idx) moved.push(`#${h8(id)}:${p.idx}→${idx}`);
        for (const [k, v] of Object.entries(it)) {
          const a = sig(v), b = sig(p.it[k]);
          if (a !== b) {
            if (!changedKeys.has(k)) changedKeys.set(k, []);
            changedKeys.get(k).push(`#${h8(id)} ${b}⇒${a}`);
          }
        }
      }
      for (const id of prev.keys()) if (!cur.has(id)) moved.push(`-${'#' + h8(id)}`);
    }
    console.log(`\n[第${i}/${ROUNDS}轮 ${t}] 条数=${arr.length}` + (prev ? `  位置变动=${moved.length}  值变动字段=${changedKeys.size}` : '（基线）'));
    for (const [k, list] of changedKeys) console.log(`   ★${k} 变了 ${list.length} 处: ${list.slice(0, 3).join(' | ')}`);
    if (moved.length) console.log(`   位置: ${moved.slice(0, 8).join(' ')}${moved.length > 8 ? ' …' : ''}`);
    appendFileSync(LOG, JSON.stringify({
      t, n: arr.length, moved,
      changed: Object.fromEntries([...changedKeys].map(([k, v]) => [k, v.slice(0, 20)])),
      order: arr.map(idOf).filter(Boolean),
    }) + '\n');
    prev = cur;
    if (i < ROUNDS) await new Promise(s => setTimeout(s, GAP));
  }
  console.log(`\n逐轮记录已追加：${LOG}`);
  console.log('判读：若某轮 changed 为空且 moved 为空 ⇒ 关注列表在这段时间对在线态完全不敏感。');
})();
