/**
 * 定点诊断：康楚翊(149356883) 的直播，LRC 里到底有多少「弦月回响」
 * gnz 说她 live=238 分，我们侧 = 0。
 */
import { postJson, fetchText } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const UID = process.env.UID || '149356883';
const NAME = '弦月回响';

const px = (process.env.SCRAPE_PROXY || '').split(',').map(s => s.trim()).filter(Boolean)[0];

const fetchLrc = (url) => fetchText(url, { timeout: 40000 });

const log = (...a) => console.log(...a);

// 全团最新 liveId 作为按成员翻页的起点（next=0 会忽略 userId）
const g = await postJson('/live/api/v1/live/getLiveList', { debug: true, next: '0', record: true }, { token: TOKEN });
const seed = (g.content && g.content.liveList && g.content.liveList[0] && g.content.liveList[0].liveId) || '0';
log('种子 liveId =', seed);

// 按成员翻
const mine = [];
let next = String(seed);
for (let p = 0; p < 6; p++) {
  const r = await postJson('/live/api/v1/live/getLiveList',
    { debug: true, next, record: true, userId: Number(UID) }, { token: TOKEN });
  const list = (r.content && r.content.liveList) || [];
  if (!list.length) break;
  for (const x of list) {
    if (String((x.userInfo || {}).userId) !== String(UID)) continue;  // 防服务端回错
    mine.push({ liveId: String(x.liveId), ctime: Number(x.ctime) || 0, title: x.title || '' });
  }
  const nx = String((r.content && r.content.next) || '0');
  if (!nx || nx === '0' || nx === next) break;
  next = nx;
  if (mine.length && mine[mine.length - 1].ctime && mine[mine.length - 1].ctime < Date.UTC(2026, 9, 23)) break;
}
log(`她的录播 ${mine.length} 场`);

const SINCE = Date.UTC(2026, 9, 23, 16, 0, 0); // 北京 2026-10-24 00:00
let tot = 0;
for (const s of mine.slice(0, 10)) {
  if (s.ctime < SINCE) continue;
  const one = (await postJson('/live/api/v1/live/getLiveOne', { liveId: s.liveId }, { token: TOKEN })).content || {};
  const url = one.msgFilePath || '';
  const bj = new Date(s.ctime + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ');
  if (!url) { log(`[${bj}] ${s.liveId} 无回放(msgFilePath 空) status=${one.status}`); continue; }
  let text = '';
  try { text = await fetchLrc(url); } catch (e) { log(`[${bj}] 下载失败 ${e.message.slice(0, 70)}`); continue; }
  const lines = text.split('\n').filter(Boolean).length;
  const hits = (text.match(/弦月回响/g) || []).length;
  const giftLines = (text.match(/送给/g) || []).length;
  log(`[${bj}] ${s.liveId} bytes=${text.length} 行=${lines} 含弦月回响=${hits} 送礼行=${giftLines} url=${url.slice(0, 90)}`);
  if (hits && tot < 3) {
    const s2 = text.split('\n').filter(l => l.includes('弦月回响')).slice(0, 4);
    s2.forEach(l => log('      ' + l.slice(0, 150)));
    tot++;
  }
}
