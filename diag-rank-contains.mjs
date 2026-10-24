/**
 * 判定「弦月回响」是否进 getLiveRank 榜单。
 *
 * 若进榜 → 直播中轮询 getLiveRank 差分即可实现实时计分。
 * 若不进 → 实时只能靠弹幕（NIM），而 NIM 我们被 403 拒绝。
 *
 * 做法：取若干「弦月个数多」的已结束场次，把 LRC 的送礼人名单与榜单名单做宽松比对
 *      （去掉空格/符号/括号/大小写后互相 includes），打印交集与两侧独有。
 *
 * 用法：node diag-rank-contains.mjs [场次数=6]
 */
import { postJson, fetchText } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const GIFT_NAME = process.env.GIFT_NAME || '弦月回响';
const N = Math.max(1, Number(process.argv[2] || 6));
const RE_LINE = /^\[(\d+):(\d+):([\d.]+)\]([^\t]*)\t(.*)$/;
const RE_GIFT = /送给\s*(\S+?)\s*(\d+)\s*个\s*(.+)$/;

// 宽松归一：只留中日韩文字 + 英数，去掉一切符号/表情/空格
const core = (s) => String(s || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
const loose = (a, b) => {
  const x = core(a), y = core(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 3 && y.includes(x)) return true;
  if (y.length >= 3 && x.includes(y)) return true;
  return false;
};

function sendersOf(text) {
  const m = new Map();
  let total = 0;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const t = RE_LINE.exec(line);
    if (!t) continue;
    const g = RE_GIFT.exec(t[5]);
    if (!g) continue;
    if ((g[3] || '').indexOf(GIFT_NAME) < 0) continue;
    const nick = (t[4] || '').trim();
    const num = Math.max(1, Math.floor(Number(g[2]) || 1));
    m.set(nick, (m.get(nick) || 0) + num);
    total += num;
  }
  return { m, total };
}

// 拉一批已结束场次（按弦月个数排序取前 N）
let next = '0';
const all = [];
for (let p = 0; p < 6; p++) {
  const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 3 });
  const list = r.content?.liveList || [];
  if (!list.length) break;
  all.push(...list);
  const nx = r.content?.next;
  if (!nx || nx === '0' || nx === next) break;
  next = nx;
  if (all.length > 80) break;
}

const since = Date.now() - 12 * 3600e3;
const cands = all.filter((s) => Number(s.ctime) >= since).slice(0, 24);
console.log(`先粗扫 ${cands.length} 场，找弦月多的…\n`);

const scored = [];
for (const s of cands) {
  const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 2 })).content || {};
  if (!one.msgFilePath) continue;
  let text = '';
  try { text = await fetchText(one.msgFilePath, { timeout: 40000 }); } catch { continue; }
  const { m, total } = sendersOf(text);
  if (total) scored.push({ s, senders: m, total });
}
scored.sort((a, b) => b.total - a.total);

for (const { s, senders, total } of scored.slice(0, N)) {
  const nick = String(s.userInfo?.nickname || s.liveId);
  const r = await postJson('/live/api/v1/live/getLiveRank', { liveId: String(s.liveId), type: '1', page: 1, limit: 200 }, { token: TOKEN, retries: 3 });
  const rank = Array.isArray(r.content) ? r.content : [];
  const rankNames = rank.map((x) => String(x.user?.userName || ''));
  const rankSum = rank.reduce((a, x) => a + (Number(x.money) || 0), 0);

  const hit = [];
  const miss = [];
  for (const [nickName, num] of senders) {
    const found = rankNames.find((rn) => loose(nickName, rn));
    (found ? hit : miss).push(`${nickName}(${num})${found ? '=' + found : ''}`);
  }
  console.log(`\n【${nick}】弦月 ${total}个/${senders.size}人 | 榜单 ${rank.length}人/money ${rankSum}`);
  console.log(`  命中 ${hit.length} 人：${hit.slice(0, 8).join(' , ')}`);
  console.log(`  不在榜 ${miss.length} 人：${miss.slice(0, 8).join(' , ')}`);
  console.log(`  命中率 ${(hit.length / senders.size * 100).toFixed(0)}%`);
}

console.log('\n=== 汇总 ===');
let th = 0, ts = 0;
for (const z of scored) { /* 仅说明 */ }
console.log(`共分析 ${Math.min(N, scored.length)} 场（弦月最多优先）`);
process.exit(0);
