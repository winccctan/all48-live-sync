/**
 * 一次性探针：取官方礼物价目表，确认「弦月回响」是否存在、giftId 是多少
 *
 * 为什么需要：GIFT_TEXT 里只有 giftName / giftId，没有价值。计分要按 giftId 精确过滤
 * （同一个礼物改名后名字会变，id 不变；活动打分道具也是 888xxx 的 id）。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

const bodies = [
  {},
  { giftType: 1 },
  { businessId: 0, giftType: 1 },
];

for (const b of bodies) {
  console.log('\n===== /gift/api/v1/gift/list  body=' + JSON.stringify(b));
  try {
    const d = await postJson('/gift/api/v1/gift/list', b, { token: TOKEN, retries: 1 });
    const c = (d && d.content) || {};
    const list = Array.isArray(c) ? c : (Array.isArray(c.giftList) ? c.giftList : (Array.isArray(c.list) ? c.list : []));
    console.log('status=' + (d && d.status) + ' msg=' + (d && d.msg) + ' content keys=' + JSON.stringify(Object.keys(c || {})).slice(0, 200));
    console.log('礼物数 ' + list.length);
    if (list.length) {
      console.log('样本字段 ' + JSON.stringify(Object.keys(list[0])));
      for (const g of list) {
        const nm = g.giftName || g.name || '';
        if (String(nm).indexOf('弦月') >= 0 || String(nm).indexOf('回响') >= 0 || String(nm).indexOf('月') >= 0) {
          console.log('  ★ ' + JSON.stringify({ id: g.giftId || g.id, name: nm, money: g.money, price: g.price, type: g.giftType }));
        }
      }
      console.log('全部名字：' + list.map((g) => (g.giftName || g.name)).join(' / ').slice(0, 1200));
    }
  } catch (e) {
    console.log('  失败 ' + String((e && e.message) || e).slice(0, 160));
  }
}
