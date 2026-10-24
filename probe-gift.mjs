/**
 * 一次性探针：确认「成员房间消息接口」里到底有没有粉丝送礼消息（GIFT_TEXT）
 *
 * 目的（2026-10-24 红蓝活动计分）：
 *   要统计「弦月回响」礼物，必须先证明三件事：
 *     ① 接口返回里含粉丝消息（channelRole=0），不只有房主（成员）发言；
 *     ② 粉丝送礼是 GIFT_TEXT，且 bodys 里有 giftName / giftNum；
 *     ③ 送的人（user_id / nickname）能拿到。
 *
 * 只读、不上报。跑在 GitHub Actions（走国内代理），因为口袋48 对海外 IP 一律 403。
 */
import { fetchMessagePage } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.POCKET48_TOKEN || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

// 1) 成员目录
const txt = await (await fetch(SITE + '/data/members.js', { headers: { 'User-Agent': UA } })).text();
const all = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
console.log('成员目录 ' + all.length + ' 人');

// 2) 抽样：取「有房间(srv/ch)」的前若干人 + 指定 uid
const pick = (process.env.PROBE_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
let sample = all.filter((m) => m.srv && m.ch);
if (pick.length) sample = sample.filter((m) => pick.includes(Number(m.id)));
else sample = sample.slice(0, 6);

const LIMIT = Number(process.env.PROBE_LIMIT || 100);
const giftNames = new Map();     // giftName -> 次数
let totalMsgs = 0, fanMsgs = 0, giftMsgs = 0, ownerMsgs = 0;
const giftSamples = [];
const typeCount = new Map();

for (const m of sample) {
  try {
    const r = await fetchMessagePage({ serverId: m.srv, channelId: m.ch, nextTime: 0, limit: LIMIT, token: TOKEN });
    const msgs = r.messages || [];
    let fan = 0, gift = 0, owner = 0;
    for (const x of msgs) {
      totalMsgs++;
      const t = String(x.msgType || 'TEXT');
      typeCount.set(t, (typeCount.get(t) || 0) + 1);
      let ext = {};
      try { ext = typeof x.extInfo === 'string' ? JSON.parse(x.extInfo) : (x.extInfo || {}); } catch (e) { ext = {}; }
      const role = Number(ext.channelRole);
      if (role === 2) owner++; else fan++;
      if (t === 'GIFT_TEXT') {
        gift++;
        let ct = {};
        try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch (e) { ct = {}; }
        const gi = ct.giftInfo || ct;
        const name = String(gi.giftName || '');
        giftNames.set(name, (giftNames.get(name) || 0) + 1);
        if (giftSamples.length < 6) {
          giftSamples.push({
            member: m.n, uid: m.id,
            senderId: (ext.user && ext.user.userId) || null,
            senderNick: (ext.user && (ext.user.nickname || ext.user.nickName)) || null,
            role, msgTime: x.msgTime, bodys: String(x.bodys).slice(0, 260),
          });
        }
      }
    }
    ownerMsgs += owner; fanMsgs += fan; giftMsgs += gift;
    console.log(`  ${m.n}(uid=${m.id}) 取回 ${msgs.length} 条 → 房主 ${owner} / 粉丝 ${fan} / 礼物 ${gift}`);
  } catch (e) {
    console.log(`  ${m.n}(uid=${m.id}) 失败：${String(e.message || e).slice(0, 120)}`);
  }
}

console.log('\n===== 汇总 =====');
console.log('样本消息 ' + totalMsgs + ' 条：房主 ' + ownerMsgs + ' / 粉丝 ' + fanMsgs + ' / GIFT_TEXT ' + giftMsgs);
console.log('消息类型分布：' + JSON.stringify([...typeCount.entries()].sort((a, b) => b[1] - a[1])));
console.log('礼物名 TOP：' + JSON.stringify([...giftNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)));
console.log('含「弦月回响」：' + [...giftNames.keys()].some((n) => n.indexOf('弦月') >= 0));
console.log('\nGIFT_TEXT 样本：');
for (const s of giftSamples) console.log('  ' + JSON.stringify(s));
