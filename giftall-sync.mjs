/**
 * 一次性：全团房间「全礼物」抓取（不上报站点，只落本地 JSON）
 *   node giftall-sync.mjs
 *
 * 目的：给「口袋48 礼物鸡腿榜」demo 提供真实数据。
 * 与 gift-sync.mjs 的区别：那个只留弦月回响并上报站点；这个全收、算鸡腿、写本地文件。
 *
 * 环境变量：
 *   SITE_URL / POCKET48_TOKEN / SCRAPE_PROXY
 *   PAGES=3        每人往回翻几页（50 条/页）
 *   CONC=6         并发
 *   SINCE=ts       只留 >= 该毫秒时间戳的（默认今天北京 0 点）
 *   OUT=/path.json
 *   MAX_MEMBERS=600
 */
import { fetchMessagePage } from './lib/api.mjs';
import { priceOf, isNoPrice } from './lib/gift-price.mjs';
import { writeFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

const CONC = Math.max(1, Number(process.env.CONC || 6));
const PAGES = Math.max(1, Number(process.env.PAGES || 3));
const LIMIT = 50;
const MAX_MEMBERS = Number(process.env.MAX_MEMBERS || 600);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BJ = 8 * 3600 * 1000;
const now = Date.now();
const todayStart = (() => {
  const d = new Date(now + BJ);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BJ;
})();
const SINCE = Number(process.env.SINCE || todayStart);
const OUT = process.env.OUT || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/output/giftall-' + new Date(now + BJ).toISOString().slice(0, 10).replace(/-/g, '') + '.json';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const t0 = Date.now();
const txt = await (await fetch(SITE + '/data/members.js', { headers: { 'User-Agent': UA } })).text();
const members = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const byId = new Map(members.map((m) => [Number(m.id), m]));
let uids = members.filter((m) => m && m.id && m.srv && m.ch).map((m) => Number(m.id));
if (uids.length > MAX_MEMBERS) uids = uids.slice(0, MAX_MEMBERS);
log(`成员 ${members.length} / 有房间 ${uids.length} · 起算 ${new Date(SINCE + BJ).toISOString().slice(0, 19)} (北京)`);

const items = [];
const stats = {};      // 礼物名 → 条数
const unknown = {};    // 查不到价的礼物名
let ok = 0, empty = 0, err = 0, pages = 0;
let cur = 0;

async function worker() {
  for (;;) {
    const i = cur++;
    if (i >= uids.length) return;
    const m = byId.get(uids[i]);
    let next = 0;
    let got = 0;
    try {
      for (let p = 0; p < PAGES; p++) {
        const r = await fetchMessagePage({ serverId: m.srv, channelId: m.ch, nextTime: next, limit: LIMIT, token: TOKEN, scope: 'all' });
        pages++;
        if (!r.messages.length) break;
        let oldest = Infinity;
        for (const x of r.messages) {
          const t = Number(x.msgTime) || 0;
          if (t) oldest = Math.min(oldest, t);
          if (!t || t < SINCE) continue;
          let ext = {};
          try { ext = typeof x.extInfo === 'string' ? JSON.parse(x.extInfo) : (x.extInfo || {}); } catch { continue; }
          const u = ext.user || {};
          const sid = Number(u.userId) || 0;
          if (!sid) continue;
          let ct = {};
          try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch { continue; }
          const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
          if (!gi) continue;
          const g = String(gi.giftName || '');
          const num = Math.max(1, Math.floor(Number(gi.giftNum) || 1));
          const gid = String(gi.giftId || '');
          const v = priceOf(gid, g);
          // 🔴 「直播弹幕」这类明确不计价的道具不算未知价，别混进报警列表
          if (!v && !isNoPrice(gid, g)) unknown[g] = (unknown[g] || 0) + 1;
          stats[g] = (stats[g] || 0) + 1;
          items.push({
            t, mid: Number(m.id), mn: m.n, g,
            sid, sn: String(u.nickname || u.nickName || '').slice(0, 40),
            num, v, val: num * v,
            room: 1,                       // 1 = 大家房间（直播间那条链路会写 2）
          });
          got++;
        }
        // 已经翻到今天之前就不用再往前
        if (oldest < SINCE) break;
        if (!r.nextTime || String(r.nextTime) === '0' || String(r.nextTime) === String(next)) break;
        next = r.nextTime;
      }
      if (got) ok++; else empty++;
    } catch (e) {
      err++;
      if (err <= 8) log(`  ${m.n || uids[i]} 失败 ${String(e.message).slice(0, 70)}`);
    }
    if ((ok + empty + err) % 60 === 0) log(`进度 ${ok + empty + err}/${uids.length}`);
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, uids.length) }, worker));
log(`扫完：有礼物 ${ok} 房 / 空 ${empty} / 失败 ${err} · 翻页 ${pages} · 记录 ${items.length} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const totalValue = items.reduce((a, b) => a + b.val, 0);
const totalNum = items.reduce((a, b) => a + b.num, 0);
log(`鸡腿合计 ${totalValue} · 礼物件数 ${totalNum} · 未知价礼物 ${JSON.stringify(unknown)}`);
log('礼物分布：' + JSON.stringify(Object.entries(stats).sort((a, b) => b[1] - a[1]).slice(0, 20)));

writeFileSync(OUT, JSON.stringify({ at: Date.now(), since: SINCE, items }, null, 0));
log('写到 ' + OUT);
