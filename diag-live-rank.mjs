/**
 * 校验 getLiveRank 的 money 到底代表什么：和「回放弹幕里的弦月回响个数」逐场对账。
 * 用法：node diag-live-rank.mjs [场次数]
 */
import { postJson, fetchText } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const BJ = 8 * 3600e3;
const SINCE = Date.parse(process.env.SINCE || '2026-10-23T16:00:00Z');
const NAME = process.env.GIFT_NAME || '弦月回响';
const N = Number(process.argv[2] || 8);
const RE_GIFT = /送给\s*(\S+?)\s*(\d+)\s*个\s*(.+)$/;

const bj = (ms) => new Date(Number(ms) + BJ).toISOString().slice(5, 16).replace('T', ' ');

// 拉已结束场次（翻几页即可，足够取最近 N 场）
let next = '0', lives = [];
for (let p = 0; p < 4; p++) {
  const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 3 });
  const list = r.content?.liveList || [];
  if (!list.length) break;
  for (const s of list) if (Number(s.ctime) >= SINCE) lives.push(s);
  if (Math.max(...list.map((x) => Number(x.ctime) || 0)) < SINCE) break;
  const nx = r.content?.next;
  if (!nx || nx === '0' || nx === next) break;
  next = nx;
}
lives.sort((a, b) => Number(b.ctime) - Number(a.ctime));
console.log(`今日已结束场次 ${lives.length}，取最近 ${Math.min(N, lives.length)} 场对账\n`);

let sumLrc = 0, sumMoney = 0;
for (const s of lives.slice(0, N)) {
  const nick = String(s.userInfo?.nickname || s.liveId);
  const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(s.liveId) }, { token: TOKEN, retries: 3 })).content || {};
  // ① 回放弹幕里的弦月回响个数
  let cnt = 0, lines = 0;
  if (one.msgFilePath) {
    try {
      const txt = await fetchText(one.msgFilePath, { timeout: 40000 });
      for (const ln of txt.split(/\r?\n/)) {
        lines++;
        const m = RE_GIFT.exec(ln);
        if (m && String(m[3]).trim().indexOf(NAME) >= 0) cnt += Math.max(1, Math.floor(Number(m[2]) || 1));
      }
    } catch (e) { cnt = -1; }
  }
  // ② getLiveRank 的 money 合计
  let money = 0, people = 0;
  try {
    const r = await postJson('/live/api/v1/live/getLiveRank', { liveId: String(s.liveId), type: '1', page: 1, limit: 100 }, { token: TOKEN, retries: 2 });
    const arr = Array.isArray(r.content) ? r.content : [];
    people = arr.length;
    money = arr.reduce((a, x) => a + (Number(x.money) || 0), 0);
  } catch (e) { money = -1; }
  sumLrc += Math.max(0, cnt); sumMoney += Math.max(0, money);
  const ratio = cnt > 0 ? (money / cnt).toFixed(2) : '-';
  console.log(`${bj(s.ctime)} ${nick.padEnd(12)} 弹幕行=${String(lines).padStart(5)} 弦月=${String(cnt).padStart(4)} | 榜人数=${String(people).padStart(3)} money=${String(money).padStart(6)} 比值=${ratio}`);
}
console.log(`\n合计：弦月 ${sumLrc} · money ${sumMoney} · 比值 ${(sumMoney / sumLrc || 0).toFixed(2)}`);
