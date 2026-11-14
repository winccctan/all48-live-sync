#!/usr/bin/env node
/**
 * 批量关注全体现役成员（让云信 QChat 能订阅他们的房间）
 * =====================================================================
 * 背景（2026-11-11 实测）：
 *   QChat 的 subscribeAllChannel 只能订阅「该账号已关注/已加入」的 server。
 *   实测：未关注张琼予时订阅 1148117 → failed；调
 *   POST /user/api/v2/friendships/friends/add {toSourceId:<id>, toType:1}
 *   之后同一连接订阅 → 10 个频道全部成功。
 *
 * 节奏：每个 1.6–2.8 秒随机间隔（正常粉丝行为，避免风控）。
 * 断点续跑：进度写 follow-state.json，重跑只补没成功的。
 *
 * 用法：
 *   node follow-all.mjs              # 关注全部未关注的
 *   node follow-all.mjs --dry        # 只列出名单
 *   ONLY=GNZ48 node follow-all.mjs   # 只关注某团
 * =====================================================================
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generatePa } from './pa.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STATE = resolve(HERE, 'follow-state.json');
const envFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pickEnv = (txt, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(txt);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const ROOT = resolve(HERE, '..');
const TOKEN = process.env.POCKET48_TOKEN
  || pickEnv(envFile(resolve(ROOT, 'nim-sync.env')), 'POCKET48_TOKEN')
  || pickEnv(envFile('/Users/tansy/WorkBuddy/2026-09-17-16-15-19/wangyuchen-archive/scraper/.env'), 'POCKET48_TOKEN');
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

const DRY = process.argv.includes('--dry');
const ONLY = process.env.ONLY || '';
const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' '), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headers = () => ({
  'Content-Type': 'application/json;charset=utf-8',
  Accept: '*/*',
  appInfo: JSON.stringify({
    vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
    appVersion: '7.1.43', appBuild: '26082801', osVersion: '27.0.0',
    osType: 'ios', deviceName: 'iPhone17,1', os: 'ios',
  }),
  'User-Agent': 'PocketFans201807/7.1.43 (iPhone; iOS 27.0; Scale/3.00)',
  'Accept-Language': 'zh-Hans-CN;q=1',
  token: TOKEN, pa: generatePa(), 'P-Sign-Type': 'V0',
});

async function follow(id) {
  const r = await fetch('https://pocketapi.48.cn/user/api/v2/friendships/friends/add', {
    method: 'POST', headers: headers(),
    body: JSON.stringify({ toSourceId: Number(id), toType: 1 }),
  });
  const d = await r.json().catch(() => null);
  return { http: r.status, status: d?.status, ok: d?.status === 200 && d?.success === true, msg: String(d?.message || '').slice(0, 60) };
}

/* ---------- 名单 ---------- */
const txt = await (await fetch('https://all48-archive.yqz-tansy.workers.dev/data/members.js?v=' + Date.now())).text();
const all = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
let list = all.filter((m) => m && m.id && String(m.tm || '').indexOf('荣誉') < 0);
if (ONLY) list = list.filter((m) => String(m.g || '').includes(ONLY));

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { done: {}, fail: {} };
const todo = list.filter((m) => !state.done[m.id]);
log(`名册 ${all.length} · 目标 ${list.length} · 已关注 ${Object.keys(state.done).length} · 待办 ${todo.length}`);
if (DRY) { console.log(todo.slice(0, 60).map((m) => `${m.n}(${m.id})`).join(' ')); process.exit(0); }

let ok = 0, fail = 0, n = 0;
for (const m of todo) {
  let res;
  try { res = await follow(m.id); } catch (e) { res = { ok: false, msg: String(e.message).slice(0, 40) }; }
  n++;
  if (res.ok) { state.done[m.id] = m.n; delete state.fail[m.id]; ok++; }
  else {
    // 重试一次（网络抖动）
    await sleep(1200);
    try { res = await follow(m.id); } catch (e) { res = { ok: false, msg: String(e.message).slice(0, 40) }; }
    if (res.ok) { state.done[m.id] = m.n; delete state.fail[m.id]; ok++; }
    else { state.fail[m.id] = `${m.n}:${res.msg}`; fail++; }
  }
  if (n % 20 === 0) {
    writeFileSync(STATE, JSON.stringify(state));
    log(`进度 ${n}/${todo.length} · ok ${ok} · fail ${fail}`);
  }
  await sleep(1600 + Math.floor(Math.random() * 1200));
}
writeFileSync(STATE, JSON.stringify(state));
log(`完成：ok ${ok} · fail ${fail} · 累计已关注 ${Object.keys(state.done).length}`);
if (fail) log('失败样本：' + Object.values(state.fail).slice(0, 8).join(' | '));
