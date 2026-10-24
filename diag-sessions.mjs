/**
 * 诊断：getLiveList(record:true) 到底能翻出多少场「已结束」直播？
 * 对照 gnz 的 liveHistory.completedLives（它报 73 场）。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const BJ = 8 * 3600e3;
const SINCE = Date.UTC(2026, 9, 24, 0, 0, 0) - BJ;   // 北京 2026-10-24 00:00

const log = (...a) => console.log(...a);
const all = [];
let next = '0';
let pages = 0;
let stopReason = '';

for (let p = 0; p < 40; p++) {
  let r;
  try {
    r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), record: true }, { token: TOKEN, retries: 2 });
  } catch (e) { stopReason = '请求失败 ' + String(e.message).slice(0, 60); break; }
  const c = (r && r.content) || {};
  const list = c.liveList || [];
  pages++;
  if (!list.length) { stopReason = `第 ${pages} 页空`; break; }
  for (const x of list) {
    all.push({
      liveId: String(x.liveId || ''),
      nick: String((x.userInfo && x.userInfo.nickname) || ''),
      ctime: Number(x.ctime) || 0,
      status: x.status,
    });
  }
  const nx = String(c.next || '0');
  if (!nx || nx === '0' || nx === String(next)) { stopReason = `next=${nx}（翻到底）`; break; }
  next = nx;
}

const seen = new Set();
const uniq = all.filter((s) => s.liveId && !seen.has(s.liveId) && seen.add(s.liveId));
const today = uniq.filter((s) => s.ctime >= SINCE);
const sorted = today.slice().sort((a, b) => b.ctime - a.ctime);

log(`翻 ${pages} 页，收到 ${all.length} 条（去重 ${uniq.length}），停止原因：${stopReason}`);
log(`今天（>= 北京 00:00）已结束场次：${today.length} 场`);
log(`时间范围：${sorted.length ? new Date(sorted[sorted.length - 1].ctime + BJ).toISOString().slice(5, 16) : '-'} → ${sorted.length ? new Date(sorted[0].ctime + BJ).toISOString().slice(5, 16) : '-'}`);

// 按小时分布
const byHour = {};
for (const s of today) {
  const h = new Date(s.ctime + BJ).getUTCHours();
  byHour[h] = (byHour[h] || 0) + 1;
}
log('按小时分布：', Object.entries(byHour).sort((a, b) => a[0] - b[0]).map(([h, n]) => h + '时×' + n).join(' '));

log('\n最近 15 场：');
for (const s of sorted.slice(0, 15)) {
  log(`  ${new Date(s.ctime + BJ).toISOString().slice(5, 16)}  ${s.nick.padEnd(14)} status=${s.status} ${s.liveId}`);
}
