#!/usr/bin/env node
/**
 * fb-runner.mjs —— GitHub Actions 的「本地备用跑者」（FallBack Runner）
 *
 * 为什么有这个文件（2026-10-26 站长：「你要保证我的项目不会因为超额出现问题」）：
 *   GitHub Actions 完全免费的前提是**仓库 public**（本项目就是 public，分钟数不计费），
 *   但仍有三种情况会让抓取停摆，而它们和「我们写得好不好」无关：
 *     ① GitHub 整体故障 / runner 排队几十分钟；
 *     ② 账号被风控（公共仓库用量过大被判定滥用，Actions 被临时禁用）；
 *     ③ 仓库哪天被改成 private —— 立刻按 2000 分钟/月计费，我们一小时的用量就顶满。
 *   这三种情况下，页面会停在旧数据上一直不动。所以必须有一个**不依赖 GitHub**的跑者。
 *
 * 它干什么：
 *   每分钟问一次站点 /api/scrape/probe（判据是「礼物数据多久没进库」，不看 GitHub 状态码），
 *   - 数据新鲜（ageSec <= STALE 秒）→ 什么都不做，纯待机（几乎不耗 CPU、不占带宽）；
 *   - 数据停了 → 自己把房间礼物 / 直播补抓 / xox 对账 / 公演对账 跑起来，弹幕流常驻；
 *   - GitHub 恢复 → 自动收手，把活交回去（避免两份跑者长期并发）。
 *
 * 它依赖什么：
 *   站点 ingest 接口（INGEST_TOKEN）+ 口袋48 token + 抓取出口代理（SCRAPE_PROXY，海外 IP 直连会被 403）。
 *   这些都在同目录的 fb.env 里（install 脚本会生成，权限 600，不进 git）。
 *
 * 用法：
 *   node fb-runner.mjs            # 常驻（launchd 会这么起它）
 *   node fb-runner.mjs --once     # 只跑一轮体检就退出（自检用）
 *   FORCE=1 node fb-runner.mjs    # 无视新鲜度，立刻跑一轮各通道（演练用，跑完退出）
 */
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 读 fb.env
// 不引第三方依赖（家里那台机器不想多装东西），手写一个够用的 KEY=VALUE 解析
async function loadEnvFile(file) {
  try {
    const txt = await fsp.readFile(file, 'utf8');
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i < 1) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (e) { /* 没有 fb.env 就用进程环境变量 */ }
}
await loadEnvFile(path.join(HERE, 'fb.env'));

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const STALE = Math.max(120, Number(process.env.STALE_SEC || 420));   // 秒：超过这么久没数据就接手
const TICK = Math.max(15, Number(process.env.TICK_SEC || 60)) * 1000;
const ONCE = process.argv.includes('--once');
const FORCE = process.env.FORCE === '1';
const NODE = process.execPath;

if (!SITE) { console.error('[fb] 缺少 SITE_URL，退出'); process.exit(2); }

// 抓取端脚本统一的外部环境（口令与代理）
const BASE_ENV = {
  ...process.env,
  SITE_URL: SITE,
  INGEST_TOKEN: INGEST,
  LV_TOKEN: process.env.LV_TOKEN || INGEST,     // perf 链要它
  GIFT_NAME: process.env.GIFT_NAME || '弦月回响',
};
if (process.env.SCRAPE_PROXY && !BASE_ENV.USE_PROXY) BASE_ENV.USE_PROXY = '1';

const logFile = path.join(HERE, 'fb-runner.log');
function log(...a) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[fb ${t}] ${a.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 4 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1');
    fs.appendFileSync(logFile, line + '\n');
  } catch (e) { /* 日志写不了不影响主流程 */ }
}

// ---------------------------------------------------------------- 任务表
// every: 两次之间至少隔多久；timeout: 单次最长跑多久（超时杀掉，绝不堆积）
const TASKS = [
  { id: 'room', script: 'gift-sync.mjs', every: 120e3, timeout: 300e3,
    env: { CONC: '8', GIFT_PAGES: '2', MAX_MEMBERS: '600' } },       // 房间礼物（红蓝榜主源）
  { id: 'live', script: 'backfill-live-gift.mjs', every: 90e3, timeout: 240e3 },  // 已结束直播的回放补抓
  { id: 'xox', script: 'xox-live-backfill.mjs', every: 900e3, timeout: 1800e3 },  // 对账补差（直播唯一兜底）
  { id: 'perf', script: 'perf-gift-sync.mjs', every: 180e3, timeout: 300e3 },     // 公演礼物
  { id: 'perfhot', script: 'perf-hot-sync.mjs', every: 300e3, timeout: 300e3 },   // 公演官方对账
];
const state = Object.fromEntries(TASKS.map((t) => [t.id, { at: 0, child: null, killedFor: 0 }]));

function runTask(t) {
  const st = state[t.id];
  if (st.child) return;
  st.at = Date.now();
  const started = Date.now();
  const child = spawn(NODE, [t.script], {
    cwd: HERE,
    env: { ...BASE_ENV, ...(t.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  st.child = child;
  let out = '';
  const grab = (buf) => { out = (out + buf.toString()).slice(-4000); };
  child.stdout.on('data', grab);
  child.stderr.on('data', grab);
  const killer = setTimeout(() => {
    log(`${t.id} 超过 ${t.timeout / 1000}s，杀掉重来`);
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }, t.timeout);
  child.on('exit', (code, sig) => {
    clearTimeout(killer);
    st.child = null;
    st.killedFor = code === 0 ? 0 : st.killedFor + 1;
    const dur = ((Date.now() - started) / 1000).toFixed(1);
    const tail = out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 300);
    log(`${t.id} 结束 code=${code}${sig ? '/' + sig : ''} ${dur}s ${tail}`);
  });
  log(`${t.id} 启动`);
}

// ---------------------------------------------------------------- 弹幕流（常驻子进程）
// 直播礼物的实时源只有 48fan 的 SSE；它必须「一直挂着」，所以单独管理，
// GitHub 恢复后要主动收掉，不然两份实例同时挂流会吃 429。
const SSE = { children: [], maxRooms: String(process.env.SSE_MAX_ROOMS || '3'), shards: String(process.env.SSE_SHARDS || '2') };
function sseAlive() { return SSE.children.filter((c) => c && c.exitCode === null).length; }
function sseStart() {
  if (sseAlive() > 0) return;
  const n = Number(SSE.shards) || 1;
  for (let i = 0; i < n; i++) {
    const child = spawn(NODE, ['live-sse-sync.mjs'], {
      cwd: HERE,
      env: {
        ...BASE_ENV,
        SHARDS: String(n), SHARD: String(i), MAX_ROOMS: SSE.maxRooms,
        RUN_MINUTES: '0',            // 0 = 一直跑，由本 runner 负责启停
        FLUSH_MS: '6000',
        START_PER_MIN: '8',
        GAP_MS: '8000',
        SSE_STATE: path.join(HERE, `.sse-state-${i}.json`),
        HEALTHZ_PORT: String(8790 + i),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => log(`sse#${i} ${String(b).trim().slice(0, 200)}`));
    child.stderr.on('data', (b) => log(`sse#${i}! ${String(b).trim().slice(0, 200)}`));
    child.on('exit', (code) => log(`sse#${i} 退出 code=${code}`));
    SSE.children[i] = child;
  }
  log(`弹幕流启动 ${n} 片 × ${SSE.maxRooms} 场`);
}
function sseStop(why) {
  const live = SSE.children.filter((c) => c && c.exitCode === null);
  if (!live.length) return;
  for (const c of live) { try { c.kill('SIGTERM'); } catch (e) { /* ignore */ } }
  SSE.children = [];
  log(`弹幕流收手（${why}）`);
}

// ---------------------------------------------------------------- 探针
async function probe() {
  const r = await fetch(`${SITE}/api/scrape/probe?cb=${Date.now()}`, {
    headers: { 'user-agent': 'all48-fb-runner/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error('probe ' + r.status);
  return r.json();
}

// ---------------------------------------------------------------- 主循环
let missStreak = 0;
let lastIdleLog = 0;

async function tick() {
  let p;
  try {
    p = await probe();
    missStreak = 0;
  } catch (e) {
    missStreak++;
    // 探针都打不通说明是网络/站点问题，此时贸然开跑可能只是白烧带宽 ⇒ 连续 3 次才动手
    log(`探针失败(${missStreak}) ${e.message}`);
    if (missStreak < 3) return;
    p = { verdict: 'stale', gift: { ageSec: -1 } };
  }

  const stale = FORCE || p.verdict === 'stale';
  if (!stale) {
    sseStop('GitHub 已恢复');
    if (Date.now() - lastIdleLog > 30 * 60000) {
      lastIdleLog = Date.now();
      log(`待机中（数据 ${p.gift && p.gift.ageSec}s 前更新，正常）`);
    }
    return;
  }

  log(`接手：数据已 ${p.gift ? p.gift.ageSec : '?'}s 未更新`);
  sseStart();
  const now = Date.now();
  for (const t of TASKS) {
    const st = state[t.id];
    if (st.child) continue;
    if (now - st.at < t.every) continue;
    // 连续失败就退避：2 次失败 → 等 3 倍间隔，避免把出口代理和 48fan 打爆
    const backoff = st.killedFor >= 2 ? t.every * 3 : t.every;
    if (st.killedFor >= 2 && now - st.at < backoff) continue;
    runTask(t);
  }
}

// ---------------------------------------------------------------- 单实例锁
const lockFile = path.join(HERE, '.fb-runner.pid');
try {
  const old = Number((await fsp.readFile(lockFile, 'utf8')).trim());
  if (old && old !== process.pid) {
    try { process.kill(old, 0); console.error(`[fb] 已有实例在跑 pid=${old}，退出`); process.exit(0); } catch (e) { /* 旧的已死 */ }
  }
} catch (e) { /* 没锁文件 */ }
await fsp.writeFile(lockFile, String(process.pid)).catch(() => {});
const release = () => { try { if (Number(fs.readFileSync(lockFile, 'utf8').trim()) === process.pid) fs.unlinkSync(lockFile); } catch (e) { /* ignore */ } };
process.on('exit', release);
process.on('SIGINT', () => { sseStop('收到 SIGINT'); release(); process.exit(0); });
process.on('SIGTERM', () => { sseStop('收到 SIGTERM'); release(); process.exit(0); });

log(`启动 pid=${process.pid} 站点=${SITE} 判停阈值=${STALE}s 轮询=${TICK / 1000}s${FORCE ? ' 【FORCE 演练】' : ''}`);

if (ONCE || FORCE) {
  await tick();
  if (FORCE) {
    // 演练：把各通道各跑一次，等它们结束再退出
    await new Promise((r) => {
      const iv = setInterval(() => {
        const busy = TASKS.some((t) => state[t.id].child);
        if (!busy) { clearInterval(iv); r(); }
      }, 1000);
    });
    sseStop('演练结束');
  }
  process.exit(0);
}

// 常驻：先用一轮，之后定时
await tick();
setInterval(() => { tick().catch((e) => log('tick 异常 ' + e.message)); }, TICK);
