/**
 * ① server/jump 逐个成员查「当前」channelId，跟 roster 比对 → 量化过期规模
 * ② 直播侧口径验证：康楚_irq 房间频道的弦月回响，按「是否在直播时间窗内」切分
 * ③ 找「全员 uid 列表」接口（补 roster 里没有的 25 人）
 */
import { postJson, fetchMessagePage } from './lib/api.mjs';

const T = process.env.POCKET48_TOKEN;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- ③ 先试「全员成员列表」接口 ---------- */
log('=== ③ 找全员 uid 列表接口 ===');
for (const [p, b] of [
  ['/user/api/v1/user/star/list', {}],
  ['/user/api/v1/user/star/all', {}],
  ['/user/api/v1/star/list', {}],
  ['/im/api/v1/im/star/list', {}],
  ['/user/api/v1/user/star/archives', { memberId: 0 }],
  ['/user/api/v1/friendships/friends/id', {}],
  ['/live/api/v1/live/getStarList', {}],
  ['/user/api/v1/user/star/rank', {}],
]) {
  try {
    const r = await postJson(p, b, { token: T, retries: 0 });
    const s = JSON.stringify(r);
    if (s.length < 2000 && !/系统处理异常|解密错误/.test(s)) log(`  ✓ ${p} ${JSON.stringify(b)} → ${s.slice(0, 400)}`);
    else log(`  · ${p} → len ${s.length} ${s.slice(0, 100)}`);
  } catch (e) { log(`  × ${p} → ${String(e.message).slice(0, 70).replace(/\n/g, ' ')}`); }
}

/* ---------- ① server/jump 量化 roster 过期 ---------- */
log('');
log('=== ① server/jump 对比 roster 的 ch（前 40 人）===');
const fs = await import('node:fs');
const txt = fs.readFileSync('/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/public/data/members.js', 'utf8');
const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
let same = 0, diff = 0, err = 0;
const diffs = [];
for (const m of arr.slice(0, 40)) {
  try {
    const r = await postJson('/im/api/v1/im/server/jump', { tabId: 0, targetType: 1, starId: Number(m.id) }, { token: T, retries: 1 });
    const c = r.content || {};
    const jsi = c.jumpServerInfo || {};
    const ch = c.channelId;
    if (!ch) { err++; log(`  ${String(m.n).padEnd(8)} 无 channelId（${JSON.stringify(c).slice(0, 90)}）`); continue; }
    if (Number(ch) === Number(m.ch)) { same++; log(`  ${String(m.n).padEnd(8)} ✓ 相同 ch=${ch} 房主=${jsi.serverOwnerName} 队=${jsi.teamId}`); }
    else {
      diff++; diffs.push({ n: m.n, old: m.ch, neu: ch, srv: jsi.serverId, owner: jsi.serverOwnerName });
      log(`  ${String(m.n).padEnd(8)} 🔴 变了 roster ch=${m.ch} → 现在 ch=${ch} (srv=${jsi.serverId} 房主=${jsi.serverOwnerName})`);
    }
  } catch (e) { err++; log(`  ${String(m.n).padEnd(8)} 失败 ${String(e.message).slice(0, 50)}`); }
  await sleep(150);
}
log(`  小结：相同 ${same} / 变了 ${diff} / 失败 ${err}`);

/* ---------- ② 直播时间窗切分 ---------- */
log('');
log('=== ② 康楚_irq 房间频道：按直播时间窗切分弦月回响 ===');
const DAY0 = Date.parse('2026-10-23T16:00:00Z');
// 她的直播场次（活动期内）
const first = (await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: true }, { token: T, retries: 2 })).content.liveList[0].liveId;
let next = String(first), sessions = [];
for (let p = 0; p < 15; p++) {
  const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(next), userId: 149356883, record: true }, { token: T, retries: 1 });
  const l = (r.content && r.content.liveList) || [];
  if (!l.length) break;
  sessions.push(...l);
  const nx = String(r.content.next || '0');
  if (nx === '0' || nx === String(next)) break;
  next = nx;
}
const recent = sessions.filter((x) => Number(x.ctime) >= DAY0);
log('  活动期内她的直播场次:', recent.length, recent.map((x) => new Date(Number(x.ctime)).toISOString().slice(5, 16)).join(' '));
// 直播间时长：下一场开播 或 播完（用 msgFilePath 最后一行的偏移估）
const wins = [];
for (const x of recent) {
  const s = Number(x.ctime);
  const nx = sessions.filter((y) => Number(y.ctime) > s).map((y) => Number(y.ctime)).sort((a, b) => a - b)[0];
  wins.push([s, nx || s + 2.5 * 3600e3]);
}
log('  时间窗:', JSON.stringify(wins.map((w) => [new Date(w[0]).toISOString().slice(5, 16), new Date(w[1]).toISOString().slice(5, 16)])));
// 读她的 CHAT_CHANNEL 全部
let nt = Date.now(), all = [], guard = 0;
while (guard++ < 45) {
  let r;
  try { r = await fetchMessagePage({ serverId: 27398418, channelId: 34230939, nextTime: nt, limit: 50, token: T, scope: 'all' }); }
  catch { break; }
  if (!r.messages.length) break;
  all.push(...r.messages);
  const oldest = Math.min(...r.messages.map((x) => Number(x.msgTime) || Infinity));
  if (!r.nextTime || String(r.nextTime) === String(nt)) break;
  nt = r.nextTime;
  if (oldest < DAY0 - 86400e3) break;
}
const xy = [];
for (const x of all) {
  let ct = {};
  try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch { continue; }
  const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
  if (!gi || String(gi.giftName || '').indexOf('弦月') < 0) continue;
  xy.push({ t: Number(x.msgTime), n: Number(gi.giftNum || 1) });
}
const inWin = xy.filter((g) => wins.some((w) => g.t >= w[0] && g.t <= w[1])).reduce((a, b) => a + b.n, 0);
const outWin = xy.reduce((a, b) => a + b.n, 0) - inWin;
log(`  房间频道弦月回响 总 ${outWin + inWin} 份（${xy.length} 条）· 落在直播窗内 ${inWin} · 窗外 ${outWin}`);
log(`  （gnz.hk 报 康楚_irq: room=313 live=238）`);
log('结束');
