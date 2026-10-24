/**
 * lib/gift-price.mjs 单测（不需要网络）
 *   node gift-price.test.mjs
 *
 * 基准样本来自口袋48 App「实时个人直播礼物榜」截图（2026-10-24 18:01~18:13 康楚翊场）：
 *   总鸡腿数 108 / 送礼人数 6
 *   礼物List：1个照相机、1个玫瑰花、2个直播弹幕、1个巧克力、2个荧光棒-HII
 *
 * 🔴 口径分歧：App 的 108 = 48+20+2×10+10+2×5 把弹幕算进去了；
 *    站长 2026-10-24 定「弹幕不要算鸡腿」⇒ 站内榜口径 = 88（扣掉 2×10）。
 *    下面是按站内口径断言的，App 数字只留作价目表 money 字段的校准依据。
 */
import { priceOf, giftValue, priceTable, isNoPrice } from './lib/gift-price.mjs';

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.log(`✗ ${name}  期望 ${want}，实际 ${got}`); }
}
function ok(name, cond) {
  if (cond) { pass++; } else { fail++; console.log(`✗ ${name}`); }
}

// ① 截图那一场的礼物折算（站内口径：弹幕不计价）
const shot = [
  ['照相机', 1160648774165270500, 1, 48],
  ['玫瑰花', 266592591995027460, 1, 20],
  ['直播弹幕', 0, 2, 0],
  ['巧克力', 266592613964791800, 1, 10],
  ['荧光棒-HII', 266592588543115260, 2, 10],
];
let sum = 0;
for (const [n, id, num, want] of shot) {
  const v = giftValue(num, id, n);
  eq(`截图·${n}×${num}`, v, want);
  sum += v;
}
eq('截图·总鸡腿数（站内口径，弹幕不计）', sum, 88);

// ①b 弹幕：单价 0，且能被「明确不计价」识别出来（区别于未知价）
eq('弹幕单价', priceOf(0, '直播弹幕'), 0);
ok('弹幕 = 明确不计价', isNoPrice(0, '直播弹幕'));
ok('普通礼物不是不计价', !isNoPrice(266592591995027460, '玫瑰花'));
ok('未知礼物不是不计价', !isNoPrice(123, '不存在的礼物'));
eq('弹幕数字也 0', giftValue(9, 0, '直播弹幕'), 0);

// ② 靠名字查到 / 靠 id 查到，两条路都要通
eq('按名字查', priceOf(0, '皇冠'), 5000);
eq('按 id 查', priceOf(266592614883344400, ''), 5000);
eq('名字优先于 id', priceOf(266592614883344400, '玫瑰花'), 20);

// ③ 荧光棒各队版本没列全时按前缀兜底（价目表会随赛季增删）
eq('荧光棒前缀兜底', priceOf(0, '荧光棒-AII'), 5);
eq('荧光棒未知价不误判', priceOf(0, '荧光棒'), 5);

// ④ 未知礼物返回 0，绝不猜价
eq('未知礼物', priceOf(123, '不存在的礼物'), 0);
eq('空入参', priceOf(0, ''), 0);

// ⑤ 数量保护
eq('数量 0 → 按 1 算', giftValue(0, 266592591995027460, '玫瑰花'), 20);
eq('数量负数 → 按 1 算', giftValue(-3, 266592591995027460, '玫瑰花'), 20);
eq('数量小数 → 向下取整', giftValue(2.9, 266592591995027460, '玫瑰花'), 40);

// ⑥ 价目表完整性：29 种常规礼物全在，且都 > 0
const t = priceTable();
ok('价目表 ≥ 29 种', t.length >= 29);
ok('价目表无 0 价', t.every((g) => g.money > 0));
ok('价目表无重名', new Set(t.map((g) => g.name)).size === t.length);

console.log(`\n${fail === 0 ? '✅' : '❌'} gift-price: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
