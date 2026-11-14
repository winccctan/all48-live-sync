// 48fan 周榜 vs 我方 melee:board 逐人对账
// 目标：确认我们抓的鸡腿和 48fan（X48 系）公示的周榜是否一致，差在哪一列
const SITE = 'https://all48-archive.yqz-tansy.workers.dev';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/';
import { readFileSync, writeFileSync } from 'node:fs';

const env = readFileSync(ROOT + 'all48-worker/.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const LV = pick('LV_TOKEN');

const FROM = process.argv[2] || '2026-11-02';
const TO = process.argv[3] || '2026-11-08';
const W = Number(process.argv[4] || 429);

// 1. 拉 48fan 全量
const rows = [];
for (let off = 0; off < 400; off += 50) {
  const u = `https://48fan.com/api/public/melee/query?range=custom&year=2026&dateFrom=${FROM}&dateTo=${TO}&source=all&offset=${off}&limit=50`;
  const r = await fetch(u);
  const j = await r.json();
  if (!j.ok) { console.log('48fan 报错', off, j.error); break; }
  const got = j.rows || [];
  rows.push(...got);
  if (rows.length >= j.total || !got.length) break;
  await new Promise((x) => setTimeout(x, 350));
}
console.log('48fan 拉取', rows.length, '人 | 合计', rows.reduce((a, b) => a + (b.totalMelee || 0), 0));

const fan = new Map(rows.map((x) => [Number(x.userId), x]));

// 2. 我方
const mr = await fetch(`${SITE}/api/melee/board?w=${W}`, { headers: { 'x-lv-token': LV } });
const mj = await mr.json();
const ours = new Map((mj.rows || []).map((x) => [Number(x.id), x]));
console.log('我方', ours.size, '人');

// 3. 逐人对比
const list = [];
for (const [id, f] of fan) {
  const o = ours.get(id);
  list.push({
    id,
    name: f.name,
    g: f.groupName,
    fanTotal: f.totalMelee,
    fanGift: f.giftMelee,
    fanPai: f.fanpaiMelee,
    fanPerf: f.performanceMelee,
    our: o ? o.our : 0,
    has: !!o,
    diff: (o ? o.our : 0) - f.totalMelee,
  });
}
list.sort((a, b) => b.fanTotal - a.fanTotal);

const onlyFan = list.filter((x) => !x.has);
const totalFan = list.reduce((a, b) => a + b.fanTotal, 0);
const totalOur = list.reduce((a, b) => a + b.our, 0);
console.log('\n仅 48fan 有、我方没有:', onlyFan.length, onlyFan.slice(0, 5).map((x) => x.name).join(','));
console.log('总额  48fan', totalFan.toLocaleString(), '| 我方', totalOur.toLocaleString(), '| 覆盖', (totalOur / totalFan * 100).toFixed(1) + '%');

console.log('\n排名  成员            48fan合计    礼物      翻牌     公演     我方       差       覆盖');
for (const x of list.slice(0, 20)) {
  console.log(
    String(list.indexOf(x) + 1).padStart(3),
    String(x.name).padEnd(12).slice(0, 12),
    String(x.fanTotal).padStart(10),
    String(x.fanGift).padStart(9),
    String(x.fanPai).padStart(7),
    String(x.fanPerf).padStart(8),
    String(x.our).padStart(9),
    String(x.diff).padStart(9),
    (x.fanTotal ? (x.our / x.fanTotal * 100).toFixed(1) + '%' : '—')
  );
}
writeFileSync('/tmp/melee-compare.json', JSON.stringify(list, null, 1));
console.log('\n明细已存 /tmp/melee-compare.json');
