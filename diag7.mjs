/**
 * ① LRC 是不是被截断？（看最后一行的偏移 vs 直播时长）
 * ② server/jump 给出的 channelId 对「缺席成员」是不是 CHAT_CHANNEL 且有弦月回响
 */
import { postJson, fetchMessagePage } from './lib/api.mjs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import https from 'node:https';

const T = process.env.POCKET48_TOKEN;
const agent = new HttpsProxyAgent(process.env.SCRAPE_PROXY.split(',')[0].trim());
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function getLrc(url) {
  return new Promise((res, rej) => {
    https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
      let s = ''; r.on('data', (x) => { s += x; }); r.on('end', () => res(s));
    }).on('error', rej);
  });
}

/* ① LRC 截断检查：康楚_irq + 刘钇霏 两场 */
log('=== ① LRC 是否截断（偏移分布 + 最后一行）===');
for (const [who, lid] of [['康楚_irq', '1320834913027145728'], ['刘钇霏', '1320817992859979776']]) {
  let c = {};
  try { c = (await postJson('/live/api/v1/live/getLiveOne', { liveId: lid }, { token: T, retries: 2 })).content || {}; } catch { }
  if (!c.msgFilePath) { log(`  ${who} liveId=${lid} 无 msgFilePath（该场次不存在或没回放）`); continue; }
  const txt = await getLrc(c.msgFilePath);
  const lines = txt.split('\n').filter(Boolean);
  const offs = lines.map((L) => {
    const m = /^\[(\d+):(\d+):([\d.]+)\]/.exec(L);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : -1;
  }).filter((x) => x >= 0);
  offs.sort((a, b) => a - b);
  const last = offs[offs.length - 1];
  // 缺口检测：相邻两行间隔 > 120 秒的地方
  const gaps = [];
  for (let i = 1; i < offs.length; i++) if (offs[i] - offs[i - 1] > 120) gaps.push(`${Math.round(offs[i - 1])}s→${Math.round(offs[i])}s`);
  const xy = lines.filter((L) => /弦月/.test(L)).length;
  log(`  ${who} liveId=${lid} 行 ${lines.length} 偏移 0~${Math.round(last)}s (${(last / 60).toFixed(0)}分钟) 弦月行 ${xy}`);
  log(`     >120秒缺口 ${gaps.length} 处: ${gaps.slice(0, 12).join(' ')}`);
  const buckets = {};
  for (const o of offs) { const k = Math.floor(o / 600) * 10; buckets[k] = (buckets[k] || 0) + 1; }
  log(`     每10分钟行数: ${JSON.stringify(buckets)}`);
}

/* ② server/jump 修缺席成员 */
log('');
log('=== ② 缺席成员：用 server/jump 的 channelId 能不能读到弦月回响 ===');
// 我们缺、gnz 有分的成员（uid 从 gnz 拿不到 uid，用名字 → 我们 roster 找；找不到的先跳过）
const fs = await import('node:fs');
const txtM = fs.readFileSync('/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/public/data/members.js', 'utf8');
const arr = JSON.parse(txtM.slice(txtM.indexOf('['), txtM.lastIndexOf(']') + 1));
for (const name of ['左婧媛', '杨宝君', '韩云伊', '曾雪婷', '许雅兰', '刘柳茜', '马欣宇', '吴志越']) {
  const m = arr.find((x) => x.n === name);
  if (!m) { log(`  ${name} 不在我们 roster（无 uid，需要先补名册）`); continue; }
  let ch = m.ch, srv = m.srv, via = 'roster';
  try {
    const r = await postJson('/im/api/v1/im/server/jump', { tabId: 0, targetType: 1, starId: Number(m.id) }, { token: T, retries: 1 });
    const c = r.content || {};
    if (c.channelId) { ch = c.channelId; srv = (c.jumpServerInfo || {}).serverId || srv; via = 'jump'; }
  } catch { /* noop */ }
  let fn = '?';
  try {
    const r = await postJson('/im/api/v1/im/team/room/info', { serverId: srv, channelId: ch }, { token: T, retries: 0 });
    fn = (r.content && r.content.channelInfo && r.content.channelInfo.functionType) || '?';
  } catch { /* noop */ }
  // 读该频道今天的弦月回响
  let xy = 0, n = 0, nt = Date.now();
  for (let p = 0; p < 12; p++) {
    let r;
    try { r = await fetchMessagePage({ serverId: srv, channelId: ch, nextTime: nt, limit: 50, token: T, scope: 'all' }); }
    catch { break; }
    if (!r.messages.length) break;
    for (const x of r.messages) {
      let ct = {}; try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch { continue; }
      const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
      if (gi && String(gi.giftName || '').indexOf('弦月') >= 0) { xy += Number(gi.giftNum || 1); n++; }
    }
    if (!r.nextTime || String(r.nextTime) === String(nt)) break;
    nt = r.nextTime;
  }
  log(`  ${name.padEnd(8)} roster ch=${m.ch} → ${via} ch=${ch} fn=${fn}  读到的弦月回响 = ${xy} 份 / ${n} 条`);
  await sleep(150);
}
log('结束');
