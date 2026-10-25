/**
 * 决定性测试：康楚_irq 的「直播侧 211 分」到底从哪来？
 *  ① 逐场审计她**所有**录播的 LRC，找 弦月回响 总量（gnz 说 live=211）
 *  ② 对比 getLiveList(record:true) 翻页拿到的场次数 vs 按 member(userId) 翻页
 *  ③ 探 /live/api/v2/ 下的接口
 */
import { postJson, fetchLiveListPage } from '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/lib/api.mjs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';

const T = process.env.POCKET48_TOKEN;
const agent = new HttpsProxyAgent(process.env.SCRAPE_PROXY.split(',')[0].trim());
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const DAY0 = Date.parse('2026-10-23T16:00:00Z');   // 活动起点（北京 10-24 00:00）

function getLrc(url) {
  return new Promise((res, rej) => {
    https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let s = ''; r.on('data', (x) => { s += x; }); r.on('end', () => res(s));
    }).on('error', rej);
  });
}

/* ① 康楚_irq（uid=149356883）全部录播的 LRC 审计 */
log('=== ① 康楚_irq 全部录播 LRC 审计 ===');
const first = (await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: true }, { token: T, retries: 2 })).content.liveList[0].liveId;
let next = String(first), sessions = [];
for (let p = 0; p < 15; p++) {
  const r = await fetchLiveListPage({ userId: 149356883, next, record: true });
  if (!r.list.length) break;
  sessions.push(...r.list);
  const nx = String(r.next || '0');
  if (nx === '0' || nx === String(next)) break;
  next = nx;
}
log('  按 userId 翻到', sessions.length, '场');
const recent = sessions.filter((x) => Number(x.ctime) >= DAY0);
log('  活动期内(>=北京10-24 00:00)', recent.length, '场');

let total = 0, withLrc = 0, hits = [];
for (const x of recent) {
  let c = {};
  try { c = (await postJson('/live/api/v1/live/getLiveOne', { liveId: String(x.liveId) }, { token: T, retries: 1 })).content || {}; } catch { continue; }
  if (!c.msgFilePath) continue;
  withLrc++;
  let txt = '';
  try { txt = await getLrc(c.msgFilePath); } catch { continue; }
  let xy = 0;
  const names = {};
  for (const L of txt.split('\n')) {
    const m = /送给\s*(\S+?)\s+(\d+)\s*个\s*(.+?)\s*$/.exec(L);
    if (!m) continue;
    names[m[3]] = (names[m[3]] || 0) + Number(m[2]);
    if (m[3].indexOf('弦月') >= 0) xy += Number(m[2]);
  }
  if (xy) { total += xy; hits.push({ t: new Date(Number(x.ctime)).toISOString().slice(5, 16), xy, names }); }
  log(`  ${new Date(Number(x.ctime)).toISOString().slice(5, 16)} 行 ${txt.split('\n').length} 弦月 ${xy}`);
}
log('  🔴 有 LRC 场次', withLrc, '/', recent.length, '  弦月回响合计 =', total, '（gnz 报 live=211）');
log('  命中明细:', JSON.stringify(hits.map((h) => h.t + ':' + h.xy)));

/* ② 全团 list 翻页能拿到多少今天场次 */
log('');
log('=== ② getLiveList(record:true) 全团翻页 vs 实际场次 ===');
let n2 = '0', all = [];
for (let p = 0; p < 40; p++) {
  const r = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: String(n2), record: true }, { token: T, retries: 2 });
  const c = r.content || {};
  const l = c.liveList || [];
  if (!l.length) break;
  all.push(...l);
  const nx = String(c.next || '0');
  if (nx === '0' || nx === String(n2)) break;
  n2 = nx;
}
const todayAll = all.filter((x) => Number(x.ctime) >= DAY0);
log('  翻到总场次', all.length, ' 活动期内', todayAll.length, '场');
const byName = {};
for (const x of todayAll) { const n = (x.userInfo && x.userInfo.nickname) || '?'; byName[n] = (byName[n] || 0) + 1; }
log('  活动期内 多人开播的成员数:', Object.keys(byName).length);
log('  TOP10 场次最多的成员:', JSON.stringify(Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 10)));

/* ③ live v2 接口 */
log('');
log('=== ③ /live/api/v2/ 探测 ===');
for (const p of ['/live/api/v2/live/getLiveList', '/live/api/v2/live/getLiveOne', '/live/api/v2/live/getLiveGift', '/live/api/v2/live/getLiveRank', '/live/api/v2/live/getLiveUserList', '/live/api/v2/live/getLiveRoomList']) {
  try {
    const r = await postJson(p, { liveId: String(recent[0] && recent[0].liveId || '0'), next: '0', record: true }, { token: T, retries: 0 });
    const s = JSON.stringify(r);
    console.log('✓', p, '→ len', s.length, s.slice(0, 260));
  } catch (e) { console.log('×', p, '→', String(e.message).slice(0, 70).replace(/\n/g, ' ')); }
}
log('结束');
