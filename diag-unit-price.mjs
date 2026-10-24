/**
 * 反推「弦月回响」的单价：把 LRC 里每个送礼人的弦月个数，和 getLiveRank 里同一个人的 money 对齐。
 *
 * 目的：如果 money === num × 单价（固定单价），那么直播中只要轮询 getLiveRank 做差分、
 *      再按单价折算，就能在直播进行时算出弦月个数 —— 不需要 NIM 弹幕。
 *
 * 用法：
 *   node diag-unit-price.mjs [场次数=6]
 */
import { postJson, fetchText } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }

const GIFT_NAME = process.env.GIFT_NAME || '弦月回响';
const N_SESSIONS = Math.max(1, Number(process.argv[2] || 6));
const SINCE = Date.now() - 36 * 3600e3;

const RE_LINE = /^\[(\d+):(\d+):([\d.]+)\]([^\t]*)\t(.*)$/;
const RE_GIFT = /送给\s*(\S+?)\s*(\d+)\s*个\s*(.+)$/;

// 与 backfill-live-gift.mjs 的 parseLrc 等价，只收目标礼物，按送礼人聚合
function parseBySender(text) {
  const byNick = new Map();
  let total = 0, lines = 0;
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = RE_LINE.exec(line);
    if (!m) continue;
    lines++;
    const nick = (m[4] || '').trim();
    const g = RE_GIFT.exec(m[5]);
    if (!g) continue;
    const num = Math.max(1, Math.floor(Number(g[2]) || 1));
    const gname = (g[3] || '').trim();
    if (gname.indexOf(GIFT_NAME) < 0) continue;
    byNick.set(nick, (byNick.get(nick) || 0) + num);
    total += num;
  }
  return { byNick, total, lines };
}

const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[（(].*?[)）]/g, '').toLowerCase();

async function collectSessions() {
  let next = '0';
  const out = [];
  for (let p = 0; p < 8; p++) {
    const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 3 });
    const list = r.content?.liveList || [];
    if (!list.length) break;
    out.push(...list);
    const nx = r.content?.next;
    if (!nx || nx === '0' || nx === next) break;
    next = nx;
    if (Math.max(...list.map((x) => Number(x.ctime) || 0)) < SINCE) break;
  }
  return out
    .filter((s) => Number(s.ctime) >= SINCE)
    .sort((a, b) => Number(b.ctime) - Number(a.ctime))
    .slice(0, N_SESSIONS);
}

const sessions = await collectSessions();
console.log(`候选已结束场次 ${sessions.length} 场\n`);

const pairs = [];
for (const s of sessions) {
  const nick = String(s.userInfo?.nickname || s.liveId);
  const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 3 })).content || {};
  if (!one.msgFilePath) { console.log(`· ${nick} 无回放，跳过`); continue; }

  let text = '';
  try { text = await fetchText(one.msgFilePath, { timeout: 45000 }); } catch (e) {
    console.log(`· ${nick} 回放下载失败 ${String(e.message).slice(0, 40)}`); continue;
  }
  const { byNick, total, lines } = parseBySender(text);
  if (!total) { console.log(`· ${nick.padEnd(16)} 回放 ${lines} 行 · 无${GIFT_NAME}`); continue; }

  const r = await postJson('/live/api/v1/live/getLiveRank', { liveId: String(s.liveId), type: '1', page: 1, limit: 200 }, { token: TOKEN, retries: 3 });
  const rank = Array.isArray(r.content) ? r.content : [];
  const byUser = new Map();
  for (const x of rank) {
    const k = norm(x.user?.userName);
    byUser.set(k, (byUser.get(k) || 0) + (Number(x.money) || 0));
  }

  let matched = 0;
  for (const [sn, num] of byNick) {
    const money = byUser.get(norm(sn));
    if (money === undefined) continue;
    matched++;
    pairs.push({ live: nick, sn, num, money });
  }
  const rankSum = rank.reduce((a, x) => a + (Number(x.money) || 0), 0);
  console.log(`✔ ${nick.padEnd(16)} 弦月 ${String(total).padStart(4)}个/${byNick.size}人 · 榜单 ${String(rank.length).padStart(3)}人/money ${String(rankSum).padStart(6)} · 对上 ${matched}`);
}

console.log(`\n=== 逐人对齐（共 ${pairs.length} 对）===`);
pairs.sort((a, b) => a.num - b.num || a.money - b.money);
for (const p of pairs.slice(0, 60)) {
  const unit = p.num ? p.money / p.num : 0;
  console.log(`  ${String(p.num).padStart(3)}个  money=${String(p.money).padStart(7)}  单价=${unit.toFixed(2).padStart(10)}  ${p.sn.slice(0, 18)}`);
}

const ones = pairs.filter((p) => p.num === 1).map((p) => p.money);
const cnt = new Map();
for (const m of ones) cnt.set(m, (cnt.get(m) || 0) + 1);
console.log(`\n=== num=1 的 money 分布（共 ${ones.length} 人，众数≈单价）===`);
for (const [m, c] of [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`  money=${String(m).padStart(7)}  × ${c}`);
}

process.exit(0);
