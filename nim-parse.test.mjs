/**
 * lib/nim-parse.mjs 单测（纯函数，不需要网络/长连接）
 *   node nim-parse.test.mjs
 *
 * 为什么要这么多形态：NIM 里口袋的自定义消息结构没有文档，
 * 我们到现在也只在回放 LRC 里见过纯文本形态。真机上捕获到新结构时，
 * 往 SAMPLES 里加一条样本即可，不用改解析器。
 */
import { createGiftParser } from './lib/nim-parse.mjs';

const roster = new Map([
  ['杨秋野', 8100001],
  ['覃柯蒙', 149356897],
  ['应立婷', 8200002],
  ['王语晨', 63555],
  ['段艺璇', 8100003],
]);
const target = { name: '弦月回响', ids: ['1320115721784332300'] };
const { parse, memberUid } = createGiftParser(target, roster);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra === undefined ? '' : '  → ' + JSON.stringify(extra))); }
}
function eq(name, got, want) { ok(name, got === want, { got, want }); }

console.log('\n【1】成员名反查');
eq('纯昵称', memberUid('杨秋野'), 8100001);
eq('带团前缀', memberUid('SNH48-杨秋野'), 8100001);
eq('带空格', memberUid('SNH48-杨 秋 野'), 8100001);
eq('不存在的人', memberUid('路人甲'), 0);
eq('空值', memberUid(''), 0);
eq('尾部匹配（SNH48 TEAM HII 段艺璇）', memberUid('SNH48 TEAM HII 段艺璇'), 8100003);

console.log('\n【2】纯文本弹幕（回放 LRC 那种写法）');
{
  const g = parse({ type: 'text', time: 1761291845600, fromNick: '小粉丝', text: '小粉丝  送给 SNH48-杨秋野 1个弦月回响' }, { nick: '杨秋野' });
  ok('命中', !!g);
  eq('mid', g && g.mid, 8100001);
  eq('num', g && g.num, 1);
  eq('giftName', g && g.g, '弦月回响');
  eq('送礼人昵称', g && g.sn, '小粉丝');
}

console.log('\n【3】文本里带数量与标点');
{
  const g = parse({ time: 1761291845600, text: '阿伟 送给 覃柯蒙 10个弦月回响' });
  ok('命中', !!g);
  eq('mid', g && g.mid, 149356897);
  eq('num', g && g.num, 10);
}

console.log('\n【4】自定义消息（结构体，字段名走 giftInfo.*）');
{
  const m = {
    time: 1761291845600,
    from: 'p12345678',
    fromNick: '氪金大佬',
    type: 'custom',
    content: JSON.stringify({
      type: 1001,
      data: { giftInfo: { giftId: '1320115721784332300', giftName: '弦月回响', giftNum: 3, acceptUserName: 'SNH48-应立婷', acceptUserId: 8200002 } },
    }),
  };
  const g = parse(m);
  ok('命中', !!g);
  eq('mid', g && g.mid, 8200002);
  eq('num', g && g.num, 3);
  eq('gid', g && g.gid, '1320115721784332300');
  eq('sid 从 from 的 accid 里抠', g && g.sid, 12345678);
}

console.log('\n【5】对象形态 + 深层嵌套');
{
  const g = parse({ time: 1761291845600, fromNick: '路人', content: { a: { b: { c: { giftName: '弦月回响', giftNum: 5, acceptUserName: '王语晨' } } } } });
  ok('命中', !!g);
  eq('mid', g && g.mid, 63555);
  eq('num', g && g.num, 5);
}

console.log('\n【6】只有 giftId 没名字（站点下发 id 白名单兜底）');
{
  const g = parse({ time: 1761291845600, fromNick: 'X', text: 'X 送给 段艺璇 2个 1320115721784332300' });
  ok('命中', !!g);
  eq('num', g && g.num, 2);
  eq('mid', g && g.mid, 8100003);
}

console.log('\n【7】不该命中');
ok('别的礼物', parse({ text: '小A 送给 杨秋野 1个冰美式' }) === null);
ok('普通聊天提到名字', parse({ text: '弦月回响好好听' }) === null);
ok('空消息', parse(null) === null);
ok('无 content', parse({}) === null);

console.log('\n【8】时间与数量容错');
{
  const g1 = parse({ time: 1761291845, text: 'a 送给 杨秋野 1个弦月回响' });   // 秒级
  eq('秒 → 毫秒', g1 && g1.t, 1761291845000);
  const g2 = parse({ time: 1761291845600, text: 'a 送给 杨秋野 弦月回响' });     // 没写数量
  eq('缺数量默认 1', g2 && g2.num, 1);
  const g3 = parse({ time: 1761291845600, text: 'a 送给 杨秋野 99999999个弦月回响' });
  eq('数量封顶', g3 && g3.num, 999999);
}

console.log('\n【9】直播间兜底「送给谁」');
{
  const g = parse({ time: 1761291845600, fromNick: 'b', text: 'b 送了一个弦月回响' }, { nick: '杨秋野' });
  ok('命中', !!g);
  eq('mid 用房间主播兜底', g && g.mid, 8100001);
}

console.log(`\n===== ${pass} pass / ${fail} fail =====`);
process.exit(fail ? 1 : 0);
