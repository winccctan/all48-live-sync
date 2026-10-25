/**
 * 探针：康楚翊房间 IM 里有没有「弦月回响」，直播期送礼落在哪个 channel
 */
import { postJson, fetchMessagePage } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const UID = Number(process.env.UID || 149356883);

const txt = await (await fetch('https://all48-archive.yqz-tansy.workers.dev/data/members.js')).text();
const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const m = arr.find((x) => Number(x.id) === UID);
console.log('成员:', m && m.n, 'srv=', m && m.srv, 'ch=', m && m.ch, 'lr=', m && m.lr);

const names = {}, ids = {}, roomVals = {}, fnVals = {};
let total = 0, targets = 0;
const targetRows = [];

let next = 0;
for (let p = 0; p < 6; p++) {
  const r = await fetchMessagePage({
    serverId: m.srv, channelId: m.ch, nextTime: next, limit: 50, token: TOKEN, scope: 'all',
  });
  const msgs = r.messages;
  if (!msgs.length) break;
  console.log(`第 ${p + 1} 页 ${msgs.length} 条 nextTime=${r.nextTime}`);
  for (const x of msgs) {
    total++;
    let ext = {};
    try { ext = typeof x.extInfo === 'string' ? JSON.parse(x.extInfo) : (x.extInfo || {}); } catch {}
    // 记录各种「来源」字段的取值分布
    for (const k of ['room', 'roomId', 'functionType', 'type', 'msgType', 'liveId']) {
      const v = x[k] !== undefined ? x[k] : (ext[k] !== undefined ? ext[k] : undefined);
      if (v !== undefined) {
        const bucket = k === 'functionType' ? fnVals : roomVals;
        bucket[k + '=' + String(v).slice(0, 12)] = (bucket[k + '=' + String(v).slice(0, 12)] || 0) + 1;
      }
    }
    let ct = {};
    try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch { continue; }
    const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
    if (!gi) continue;
    const nm = String(gi.giftName || '');
    names[nm] = (names[nm] || 0) + 1;
    if (gi.giftId) ids[String(gi.giftId)] = nm;
    if (nm.includes('弦月')) {
      targets++;
      if (targetRows.length < 5) targetRows.push({ t: x.msgTime, nm, num: gi.giftNum, to: ((ext.user || {}).nickname || ''), raw: JSON.stringify(x).slice(0, 300) });
    }
  }
  const nx = r.nextTime;
  if (!nx || String(nx) === '0' || String(nx) === String(next)) break;
  next = nx;
}

console.log('\n总消息', total, '弦月回响', targets);
console.log('礼物名分布:', JSON.stringify(names, null, 1).slice(0, 800));
console.log('giftId→名:', JSON.stringify(ids).slice(0, 400));
console.log('来源字段分布:', JSON.stringify({ ...roomVals, ...fnVals }, null, 1).slice(0, 600));
if (targetRows.length) { console.log('弦月样例:'); targetRows.forEach((r) => console.log('  ', r.t, r.nm, '×' + r.num, r.to)); console.log(targetRows[0].raw); }
