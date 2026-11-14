/**
 * 跨频道去重的纯逻辑验证（不连线上、不碰 KV）
 * 用 2026-11-14 20:10/20:11 曾雪婷那两条**真实**文案跑一遍，确认：
 *   · 口袋房间 与 小房间 同一条翻牌 ⇒ 只留第一条
 *   · 同一条通道里她连发两句一样的话 ⇒ 都留（不误杀）
 *   · 不同的内容 ⇒ 都留
 */
const SIG_KEEP_MS = 15 * 60e3;

const sigOfText = (text) => {
  const s = String(text || '');
  const nl = s.indexOf('\n');
  if (nl < 0) return '';
  let b = (s.slice(nl + 1).split('\n')[0] || '').replace(/^\[翻牌\]\s*/, '');
  const q = b.indexOf('（问：');
  if (q >= 0) b = b.slice(0, q);
  b = b.replace(/\s+/g, ' ').trim();
  return b.length >= 2 ? b.slice(0, 40) : '';
};
const labelOfText = (text) => (/^【[^】]*·小房间/.test(String(text || '')) ? 'small'
  : (/^【[^】]*·口袋房间/.test(String(text || '')) ? 'room' : ''));
const prefixOfId = (id) => String(id || '').split(':')[0];

function run(items, pre) {
  const sigBox = pre ? { ...pre } : {};
  const kept = [], dropped = [];
  for (const it of items) {
    const sg = sigOfText(it.text), lb = labelOfText(it.text);
    if (sg && lb) {
      const pk = it.who + '|' + sg, prev = sigBox[pk], pfx = prefixOfId(it.id);
      const sameSrc = !!prev && prev.l === lb && prev.p === pfx;
      const gap = prev ? Math.abs(it.t - Number(prev.t || 0)) : Infinity;
      if (prev && (gap <= 2000 || (!sameSrc && gap <= SIG_KEEP_MS))) { dropped.push(it.id); continue; }
      sigBox[pk] = { l: lb, p: pfx, t: it.t };
    }
    kept.push(it.id);
  }
  return { kept, dropped, sigBox };
}

const T = 1794334400000;
const cases = [
  ['① NIM 口袋房间(20:10) 先到，Actions 小房间(20:15 才拉到) 后到',
    [
      { id: 'room:161808451:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:10\n已结束💋\n↳ @//young/：还有十分钟排练了吧' },
      { id: 'small:161808451:8888:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·小房间】11-14 20:10\n[翻牌] 已结束💋（问：还有十分钟排练了吧）' },
    ], { kept: 1, dropped: 1 }],
  ['② 同频道连发两句「💋」（同一个人真发了两次）',
    [
      { id: 'room:161808451:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:11\n💋' },
      { id: 'room:161808451:' + (T + 30000), t: T + 30000, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:11\n💋' },
    ], { kept: 2, dropped: 0 }],
  ['③ 两条完全不同的内容',            [
      { id: 'room:161808451:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:11\n我在请明天店员的假' },
      { id: 'room:161808451:' + (T + 1000), t: T + 1000, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:11\n希望成功' },
    ], { kept: 2, dropped: 0 }],
  ['④ 大房间与小房间内容不同（她在小房间另说了一句）', [
      { id: 'room:161808451:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:11\n希望成功' },
      { id: 'small:161808451:8888:' + (T + 5000), t: T + 5000, who: '曾雪婷', text: '【曾雪婷·小房间】11-14 20:11\n大盘签名姐姐在沟通了 说周一解决' },
    ], { kept: 2, dropped: 0 }],
  ['⑤ 同一秒被两条链路各看到一次（时间戳同毫秒、id 前缀不同）', [
      { id: 'room:161808451:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·口袋房间】11-14 20:11\n希望成功' },
      { id: 'small:161808451:8888:' + T, t: T, who: '曾雪婷', text: '【曾雪婷·小房间】11-14 20:11\n希望成功' },
    ], { kept: 1, dropped: 1 }],
  ['⑥ 图片条目（无正文）不参与内容去重', [
      { id: 'roomimg:161808451:' + T, t: T, who: '曾雪婷', text: '', img: 'https://x/1.jpg' },
      { id: 'smallimg:161808451:8888:' + T, t: T, who: '曾雪婷', text: '', img: 'https://x/1.jpg' },
    ], { kept: 2, dropped: 0 }],
];

let bad = 0;
for (const [name, items, want] of cases) {
  const r = run(items);
  const ok = r.kept.length === want.kept && r.dropped.length === want.dropped;
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${name}\n     留下 ${r.kept.length}（期望 ${want.kept}） 丢弃 ${r.dropped.length}（期望 ${want.dropped}）` +
    (r.dropped.length ? '\n     丢掉的 id: ' + r.dropped.join(', ') : ''));
}
console.log(bad ? `\n${bad} 个用例不符合预期` : '\n全部用例通过');
process.exit(bad ? 1 : 0);
