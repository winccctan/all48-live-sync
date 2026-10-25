/**
 * 把站点 R2 里的「全礼物」明细拉下来，合成 build-lv-demo.mjs 能吃的 JSON。
 *   LV_TOKEN=xxx node pull-lv.mjs [from=YYYYMMDD] [to=YYYYMMDD] [out=/path.json]
 *
 * 数据来源：`/api/lv/all`（房间侧 giftall-sync + 直播侧 live-gift-sync ALL=1 都往这里写）。
 * 只在本地跑：LV_TOKEN 是站点 secret，不走 GitHub。
 */
import { writeFileSync } from 'node:fs';

const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const TOK = process.env.LV_TOKEN || '';
if (!TOK) { console.error('缺少 LV_TOKEN'); process.exit(1); }

const args = new Map(process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return i < 0 ? [a, ''] : [a.slice(0, i), a.slice(i + 1)];
}));
const BJ = 8 * 3600 * 1000;
const dayOf = (ms) => new Date(ms + BJ).toISOString().slice(0, 10).replace(/-/g, '');
const FROM = args.get('from') || dayOf(Date.now() - 3 * 86400000);
const TO = args.get('to') || dayOf(Date.now());
const OUT = args.get('out') || `/Users/tansy/WorkBuddy/2026-10-14-14-13-54/output/giftall-merged-${TO}.json`;

const url = `${SITE}/api/lv/all?from=${FROM}&to=${TO}`;
const r = await fetch(url, { headers: { 'x-lv-token': TOK } });
if (!r.ok) { console.error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200)); process.exit(1); }
const j = await r.json();
const rows = j.items || [];
if (!rows.length) { console.error('区间内没有数据（' + FROM + '~' + TO + '）'); process.exit(2); }

const items = rows.map(([t, mid, sid, sn, g, num, v, room]) => ({ t, mid, sid, sn, g, num, v, room }));
const minT = Math.min(...items.map((x) => x.t));

const byRoom = { 1: 0, 2: 0, 3: 0 };
for (const x of items) byRoom[x.room] = (byRoom[x.room] || 0) + 1;
const val = items.reduce((a, x) => a + (x.v || 0) * x.num, 0);

writeFileSync(OUT, JSON.stringify({ at: Date.now(), since: minT, range: [FROM, TO], items }, null, 0));
console.log(`拉到 ${items.length} 条（大家房间 ${byRoom[1]} / 成员直播 ${byRoom[2]} / 公演 ${byRoom[3]}）`);
console.log(`鸡腿合计 ${val} · 各天 ${JSON.stringify(j.days)}`);
console.log('写到 ' + OUT);
