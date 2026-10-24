/**
 * 一次性探针：取官方礼物价目表，确认「弦月回响」是否存在、giftId 是多少
 *
 * 为什么需要：GIFT_TEXT 里只有 giftName / giftId，没有价值。计分要按 giftId 精确过滤
 * （同一个礼物改名后名字会变，id 不变；活动打分道具也是 888xxx 的 id）。
 *
 * content 结构（实测）：{ "0": {typeId,typeName,specialInstru,giftList:[...]}, "1": {...}, "2": {...} }
 * 礼物在每组的 giftList 里，不在组顶层。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

/** 把 content（可能是对象分组 / 数组 / 直接带 giftList）拍平成一维礼物数组 */
function flatten(content) {
  const out = [];
  const pushList = (arr, tag) => {
    if (!Array.isArray(arr)) return;
    for (const g of arr) if (g && typeof g === 'object') out.push({ ...g, __group: tag });
  };
  if (!content) return out;
  if (Array.isArray(content)) { pushList(content, 'root'); return out; }
  if (typeof content !== 'object') return out;
  if (Array.isArray(content.giftList)) { pushList(content.giftList, content.typeName || 'root'); return out; }
  for (const k of Object.keys(content)) {
    const grp = content[k];
    if (!grp || typeof grp !== 'object') continue;
    const tag = grp.typeName != null ? grp.typeName : k;
    if (Array.isArray(grp.giftList)) pushList(grp.giftList, tag);
    else if (Array.isArray(grp)) pushList(grp, tag);
  }
  return out;
}

const bodies = [{}, { giftType: 1 }, { businessId: 0, giftType: 1 }];

for (const b of bodies) {
  console.log('\n===== /gift/api/v1/gift/list  body=' + JSON.stringify(b));
  try {
    const d = await postJson('/gift/api/v1/gift/list', b, { token: TOKEN, retries: 1 });
    const c = (d && d.content) || {};
    const list = flatten(c);
    console.log('status=' + (d && d.status) + ' msg=' + (d && d.msg));
    console.log('分组 keys=' + JSON.stringify(Object.keys(c || {})).slice(0, 200) + ' → 拍平后礼物数 ' + list.length);
    if (!list.length) continue;

    const fields = new Set();
    for (const g of list) for (const k of Object.keys(g)) fields.add(k);
    console.log('全字段 ' + JSON.stringify([...fields]));

    const nameOf = (g) => String(g.giftName || g.name || '');
    const idOf = (g) => g.giftId || g.id || '';

    // 1) 精确找「弦月回响」
    const hit = list.filter((g) => nameOf(g).indexOf('弦月') >= 0 || nameOf(g).indexOf('回响') >= 0);
    if (hit.length) {
      for (const g of hit) {
        console.log('  ★ 命中 ' + JSON.stringify({ giftId: idOf(g), giftName: nameOf(g), group: g.__group, money: g.money, price: g.price, charm: g.charm, giftType: g.giftType }));
      }
    } else {
      console.log('  ✗ 没有名字含「弦月」或「回响」的礼物');
    }

    console.log('  分组清单：');
    const byGroup = new Map();
    for (const g of list) {
      const k = g.__group || '?';
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(nameOf(g));
    }
    for (const [k, arr] of byGroup) console.log('    [' + k + '] ' + arr.length + ' 个：' + arr.join(' / ').slice(0, 600));
  } catch (e) {
    console.log('  失败 ' + String((e && e.message) || e).slice(0, 160));
  }
}
