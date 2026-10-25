#!/usr/bin/env node
/**
 * 成员名册修复（红蓝歌会「成员缺了」的根治）
 * =====================================================================
 * 解决两个问题：
 *   ① **缺人**：站内 members.js 只有 500 人，官方全团表 761 人，
 *      新预备生（陶佳妮 / 贺宇晨 / 王唯祎 …）压根不在名册里 ⇒ 房间永远扫不到。
 *   ② **channelId 过期**：成员搬过房间后 ch 不更新，扫的是空房间 ⇒ 有分也拿 0。
 *      （实测 2026-10-24：左婧媛 ch 1164995 → 实际 1312222；杨宝君 39014945 → 39031753）
 *
 * 数据源
 *   uid 来源：gnz.hk 榜单（/api/vote/members）—— 官方表 allmembers_0.jsonp 的
 *             pocket_id 实测**全是 0**，拿不到口袋 ID，只能从榜单反查名字→uid。
 *             🔴 榜单只包含「当天有分」的人，所以它只用来**补人**，不用来当全量名册。
 *   srv/ch ：口袋48 `POST /im/api/v1/im/server/jump {tabId:0,targetType:1,starId:uid}`
 *             → content.serverId / content.channelId —— 这是**当前**房间，唯一权威。
 *   团/队  ：官方表 gname/tname（移籍当天就更新）。
 *
 * 用法
 *   node sync-roster.mjs            只体检，打印报告（不写文件、不调 jump）
 *   node sync-roster.mjs --jump     调 server/jump 核对/刷新 srv+ch（不写文件）
 *   node sync-roster.mjs --write    实际改写 ../all48-worker/public/data/members.js
 *   CONC=6                          并发（默认 6）
 *   ONLY=1                          只处理「缺的人」，不刷新老成员（快）
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { postJson } from './lib/api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.env.MEMBERS_FILE || resolve(HERE, '../all48-worker/public/data/members.js');

const WRITE = process.argv.includes('--write');
const DO_JUMP = process.argv.includes('--jump') || WRITE;
const ONLY_NEW = process.env.ONLY === '1';
const CONC = Math.max(1, Number(process.env.CONC || 6));
const TOKEN = process.env.POCKET48_TOKEN || '';

const log = (...a) => console.log(...a);

/* --------------------------------------------------- 团/队 名称映射 */
const GROUP = { SNH: 'SNH48', GNZ: 'GNZ48', BEJ: 'BEJ48', CKG: 'CKG48', CGT: 'CGT48', SHY: 'SHY48', IDFT: 'IDFT' };
const TEAMS = new Set(['SII', 'NII', 'HII', 'X', 'XII', 'G', 'NIII', 'Z', 'B', 'E', 'J',
  'C', 'K', 'CII', 'GII', 'SIII', 'HIII', 'Ft']);

function mapTeam(gname, tname) {
  const t = String(tname || '').trim();
  if (!t) return '';
  if (t === '荣誉毕业生') return '荣誉毕业生';
  if (/预备生$/.test(t)) return '预备生';
  if (t.toLowerCase() === 'idft') return 'IDFT';
  if (TEAMS.has(t)) return 'TEAM ' + t;
  const g = GROUP[gname];
  if (g && (t === g || t === g.replace('48', '') || t === g + '48')) return t;
  if (t === '未入列') return '未入列';
  return t;
}

/* --------------------------------------------------- 读现有名册 */
function loadMembers() {
  const txt = readFileSync(FILE, 'utf8');
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  return arr;
}

/* --------------------------------------------------- 官方全团表 */
async function fetchOfficial() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch('https://h5.48.cn/resource/json/allmembers_0.jsonp', {
        headers: { 'user-agent': 'Mozilla/5.0' },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const txt = await r.text();
      const o = JSON.parse(txt.slice(txt.indexOf('(') + 1, txt.lastIndexOf(')')));
      const rows = o.rows || [];
      if (rows.length < 500) throw new Error('行数异常 ' + rows.length);
      log(`官方全团表 ${rows.length} 人`);
      return rows;
    } catch (e) { log('官方表取不到：' + e.message + '，重试'); await new Promise((r) => setTimeout(r, 2000)); }
  }
  return [];
}

/* --------------------------------------------------- gnz 榜单（uid 来源） */
async function fetchGnz() {
  const out = [];
  for (let p = 1; p <= 30; p++) {
    try {
      const r = await fetch(`https://gnz.hk/api/vote/members?page=${p}&pageSize=12`, {
        headers: { Accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      });
      const j = await r.json();
      const c = j.content || {};
      const items = c.items || [];
      if (!items.length) break;
      out.push(...items);
      if (out.length >= (c.total || 0)) break;
    } catch (e) { log('gnz 第 ' + p + ' 页失败：' + e.message); break; }
  }
  log(`gnz 榜单 ${out.length} 人（uid 来源）`);
  return out;
}

/* --------------------------------------------------- server/jump */
async function jump(uid) {
  const r = await postJson('/im/api/v1/im/server/jump', { tabId: 0, targetType: 1, starId: Number(uid) },
    { token: TOKEN, retries: 2 });
  const c = r.content || {};
  return { srv: Number(c.serverId) || 0, ch: Number(c.channelId) || 0, star: !!c.star };
}

/* --------------------------------------------------- 主流程 */
const mem = loadMembers();
log(`站内名册 ${mem.length} 人 → ${FILE}`);

const official = await fetchOfficial();
const offByName = new Map();
for (const r of official) {
  const n = String(r.sname || '').trim();
  if (!n) continue;
  if (!offByName.has(n)) offByName.set(n, []);
  offByName.get(n).push(r);
}

const has = new Set(mem.map((m) => String(m.n || '').trim()));

const gnz = await fetchGnz();
const missing = [];
for (const g of gnz) {
  const n = String(g.name || '').trim();
  if (!n || has.has(n)) continue;
  // 官方表里核团/队（重名取第一个；gnz 的 group 用来挑对的那条）
  const cands = offByName.get(n) || [];
  let off = cands.find((x) => GROUP[x.gname] === g.group) || cands[0] || null;
  missing.push({
    id: Number(g.id),
    n,
    g: g.group || (off ? GROUP[off.gname] : ''),
    tm: off ? mapTeam(off.gname, off.tname) : '',
    pd: off ? String(off.pname || '') : '',
    py: off ? String(off.pinyin || '') : '',
    gscore: Number(g.scoreUnits || 0) / 1e6,
  });
}
missing.sort((a, b) => b.gscore - a.gscore);
log(`\n=== 缺失成员 ${missing.length} 人（合计 ${missing.reduce((a, b) => a + b.gscore, 0).toFixed(0)} 分）===`);
for (const m of missing) log(`  + ${m.n}  uid=${m.id}  ${m.g} / ${m.tm}  ${m.pd}  今日 ${m.gscore} 分`);

/* --------------------------------------------------- jump：补人 + 刷新 */
const results = [];
let stale = 0, okCount = 0, errCount = 0;

if (!DO_JUMP) {
  log('\n（未加 --jump，跳过房间核对；报告用）');
} else {
  if (!TOKEN) { console.error('需要 POCKET48_TOKEN'); process.exit(1); }
  const targets = [];
  for (const m of missing) targets.push({ ...m, isNew: true });
  if (!ONLY_NEW) for (const m of mem) if (m.srv && m.ch && String(m.tm || '').indexOf('荣誉') < 0) targets.push({ ...m, isNew: false });

  log(`\n=== 核对房间 ${targets.length} 个（并发 ${CONC}）===`);
  let idx = 0;
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= targets.length) return;
      const t = targets[i];
      try {
        const j = await jump(t.id);
        if (!j.srv || !j.ch) { errCount++; continue; }
        const changed = !t.isNew && (Number(t.srv) !== j.srv || Number(t.ch) !== j.ch);
        if (changed) stale++;
        else okCount++;
        results.push({ ...t, srv: j.srv, ch: j.ch, changed });
        if (changed && stale <= 20) log(`  ⟳ ${t.n}  srv ${t.srv}→${j.srv}  ch ${t.ch}→${j.ch}`);
      } catch (e) {
        errCount++;
        if (errCount <= 10) log(`  ✗ ${t.n} jump 失败：${String(e.message).slice(0, 70)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));
  log(`核对完成：正常 ${okCount} · 变更 ${stale} · 失败 ${errCount}`);
}

/* --------------------------------------------------- 合并写回 */
if (WRITE) {
  const byId = new Map(mem.map((m) => [Number(m.id), m]));
  for (const r of results) {
    if (r.isNew) {
      byId.set(Number(r.id), {
        id: Number(r.id), n: r.n, g: r.g || '', tm: r.tm || '', pd: r.pd || '',
        py: r.py || '', av: '', srv: r.srv, ch: r.ch, lr: 0, rc: 0,
      });
    } else {
      const m = byId.get(Number(r.id));
      if (m) { m.srv = r.srv; m.ch = r.ch; }
    }
  }
  const out = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
  const bak = FILE + '.bak.' + Date.now();
  copyFileSync(FILE, bak);
  writeFileSync(FILE, 'window.MEMBERS=' + JSON.stringify(out) + ';\n');
  log(`\n✅ 已写入 ${out.length} 人（原 ${mem.length}）→ ${FILE}`);
  log(`   备份：${bak}`);
} else {
  log('\n（未加 --write，不写文件）');
}

log(`\n汇总：名册 ${mem.length} → ${mem.length + (results.filter((r) => r.isNew).length)} 人`);
