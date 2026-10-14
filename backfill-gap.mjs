/**
 * 48 成员档案 · 空档补齐（gap backfill）
 *
 * 背景：msg48.org 停更于 2026-09-22，实时搬运只覆盖最新几百条 ——
 * 9-23 到今天之间的发言存在真空档。本脚本用口袋48 官方接口
 * （homeowner 接口，带 token，走国内代理）把这段增量抓全。
 *
 * 每人：nextTime 游标往前翻，收集「本人发言 && t >= GAP_END」，直到翻完。
 * 结果：本地 all48-cold/gap48/<uid>.json（与已有合并去重）→ gzip 上传 /api/gap/put。
 *
 * 可重复跑：与服务端一样按 t|k 去重，重跑安全、天然增量。
 *
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN   上传目标（DRY=1 时可缺）
 *   POCKET48_TOKEN / SCRAPE_PROXY
 *   GAP_START                 边界 ISO（默认 2026-09-22T16:00:00Z = 9-23 00:00 北京）
 *   DELAY_MS                  每页间隔（默认 320）
 *   ONLY=uid,uid              只抓这些人
 *   LIMIT=N                   只抓前 N 人
 *   DRY=1                     只存本地不上传
 *   NO_UPLOAD=1               同 DRY（别名）
 */
import { fetchMessagePage } from './lib/api.mjs';
import { pocketToView, isOwnerMsg } from './lib/view.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const DELAY = Number(process.env.DELAY_MS || 320);
const DRY = !!(process.env.DRY || process.env.NO_UPLOAD);
const GAP_START = Date.parse(process.env.GAP_START || '2026-09-22T16:00:00Z'); // 9-23 00:00 +08
const PAGE = 700;
const OUT_DIR = process.env.OUT_DIR || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-cold/gap48';
const STATE_FILE = process.env.STATE_FILE || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-cold/gap48-state.json';
const CATALOG = process.env.CATALOG || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/public/data/members.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }
if (!DRY && (!SITE || !INGEST)) { console.error('缺少 SITE_URL / INGEST_TOKEN（或加 DRY=1）'); process.exit(1); }

fs.mkdirSync(OUT_DIR, { recursive: true });
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

/* ---------- 成员目录 ---------- */
const catTxt = fs.readFileSync(CATALOG, 'utf8');
const members = JSON.parse(catTxt.slice(catTxt.indexOf('['), catTxt.lastIndexOf(']') + 1));
let list = members.filter((m) => m.srv && m.ch);
if (process.env.ONLY) {
  const want = new Set(process.env.ONLY.split(',').map((s) => s.trim()));
  list = list.filter((m) => want.has(String(m.id)));
}
if (process.env.LIMIT) list = list.slice(0, Number(process.env.LIMIT));
log(`目录 ${members.length} 人，本轮 ${list.length} 人（边界 ${new Date(GAP_START).toISOString()}）`);

/** 与本地已有文件合并去重（t|k 键） */
function mergeLocal(uid, arr) {
  const f = path.join(OUT_DIR, uid + '.json');
  let cur = [];
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { cur = []; }
  const seen = new Set(cur.map((m) => m.t + '|' + m.k));
  let added = 0;
  for (const m of arr) {
    const key = m.t + '|' + m.k;
    if (seen.has(key)) continue;
    seen.add(key);
    cur.push(m);
    added++;
  }
  cur.sort((a, b) => a.t - b.t);
  fs.writeFileSync(f, JSON.stringify(cur));
  return { total: cur.length, added };
}

async function upload(uid, arr) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(arr)));
  const res = await fetch(`${SITE}/api/gap/put?uid=${uid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip', 'x-ingest-token': INGEST, 'User-Agent': UA },
    body: gz,
  });
  if (!res.ok) throw new Error(`gap/put → HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

let okN = 0, emptyN = 0, skipN = 0, errN = 0;
const t0 = Date.now();

for (const m of list) {
  const uid = String(m.id);
  const tag = `[${okN + emptyN + errN + 1}/${list.length}] ${m.n}`;
  if (state[uid] && state[uid].done && !process.env.ONLY) {
    skipN++;
    continue;
  }

  try {
    const collected = [];
    let next = 0;
    let pages = 0;
    for (;;) {
      const r = await fetchMessagePage({ serverId: m.srv, channelId: m.ch, nextTime: next, limit: PAGE, token: TOKEN });
      pages++;
      const msgs = r.messages || [];
      if (!msgs.length) break;
      for (const raw of msgs) {
        if (!isOwnerMsg(raw, Number(uid))) continue;
        const t = Number(raw.msgTime);
        if (!(t >= GAP_START)) continue;
        const v = pocketToView(raw);
        if (v && v.t && (v.x || v.i || v.a || v.v || v.c)) collected.push(v);
      }
      // 本页最早一条已越过边界 → 到头了
      const oldest = Math.min(...msgs.map((x) => Number(x.msgTime) || 0));
      if (oldest < GAP_START) break;
      if (!r.nextTime) break;
      next = r.nextTime;
      await sleep(DELAY);
    }

    if (collected.length) {
      const { total, added } = mergeLocal(uid, collected);
      if (!DRY) await upload(uid, collected);
      log(`${tag}  gap ${collected.length} 条（本地共 ${total}，新增 ${added}，${pages} 页）`);
      state[uid] = { done: true, n: total, at: Date.now() };
      okN++;
    } else {
      log(`${tag}  9-23 后无本人发言`);
      state[uid] = { done: true, n: 0, at: Date.now() };
      emptyN++;
    }
    if ((okN + emptyN) % 10 === 0) saveState();
  } catch (e) {
    errN++;
    log(`${tag}  失败：${String(e.message).slice(0, 110)}`);
  }
  await sleep(DELAY);
}

saveState();
log(`完成：成功 ${okN} / 空 ${emptyN} / 跳过 ${skipN} / 失败 ${errN} · 耗时 ${((Date.now() - t0) / 60000).toFixed(1)} 分钟`);
