/**
 * 一次性探针：确认「房间全量消息接口」能不能拿到粉丝送礼（GIFT_TEXT）
 *
 * 背景（2026-10-24 红蓝活动计分）：
 *   我们一直在用的 `/im/api/v1/team/message/list/homeowner` **只回房主（成员本人）发言**
 *   （已实测：6 人各 200 条 = 房主 200 / 粉丝 0 / GIFT_TEXT 0）。
 *   但《口袋48鸡腿接口调研》记录还有一个 `/im/api/v1/team/message/list/all` = 所有人的房间消息。
 *   这个探针就是去验它：能不能拿到 GIFT_TEXT、送礼人 ID、礼物名、数量。
 *
 * 只读、不上报。必须跑在 GitHub Actions（走国内代理），口袋48 对海外 IP 一律 403。
 */
import { postJson } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.POCKET48_TOKEN || '';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LIMIT = Number(process.env.PROBE_LIMIT || 100);
const PAGES = Math.max(1, Number(process.env.PROBE_PAGES || 4));

if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

// 1) 成员目录
const txt = await (await fetch(SITE + '/data/members.js', { headers: { 'User-Agent': UA } })).text();
const all = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
console.log('成员目录 ' + all.length + ' 人');

// 2) 抽样：在役（非荣誉毕业生）且房间信息齐全
const pick = (process.env.PROBE_UIDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
let sample = all.filter((m) => m.srv && m.ch && m.tm && String(m.tm).indexOf('荣誉') < 0);
if (pick.length) sample = all.filter((m) => pick.includes(Number(m.id)));
else sample = sample.slice(0, Number(process.env.PROBE_MEMBERS || 12));
/** 试一个接口路径，返回 message 数组 */
async function tryPath(path, m, token) {
  try {
    const data = await postJson(path, {
      channelId: m.ch, serverId: m.srv, nextTime: 0, limit: LIMIT,
    }, { token, retries: 1 });
    const c = data && data.content;
    const list = Array.isArray(c && c.message) ? c.message : [];
    return { ok: true, list, next: c && c.nextTime, status: data && data.status, msg: data && data.msg };
  } catch (e) {
    return { ok: false, list: [], err: String((e && e.message) || e).slice(0, 160) };
  }
}

/** 🔴 该接口单页上限实测 50 条（传 150 也只给 50），要往回翻只能带 nextTime 翻页 */
async function fetchPages(path, m, token, pages) {
  const all = [];
  let next = 0;
  for (let i = 0; i < pages; i++) {
    let data = null;
    try {
      data = await postJson(path, { channelId: m.ch, serverId: m.srv, nextTime: next, limit: LIMIT }, { token, retries: 1 });
    } catch (e) {
      return { ok: false, list: all, err: String((e && e.message) || e).slice(0, 160) };
    }
    const c = (data && data.content) || {};
    const list = Array.isArray(c.message) ? c.message : [];
    all.push(...list);
    const nx = c.nextTime;
    if (!list.length || !nx || String(nx) === '0' || String(nx) === String(next)) break;
    next = nx;
  }
  return { ok: true, list: all, next };
}

const PATHS = [
  // 🔴 homeowner 已实测拿不到粉丝送礼（200 条 → 非房主 0 / 礼物 0），这轮只探 list/all
  '/im/api/v1/team/message/list/all',
];

const giftNames = new Map();
const giftPairs = new Map(); // "giftId|giftName" → 次数，用来反推「弦月回响」的 giftId
const giftSamples = [];
let grand = { msgs: 0, fan: 0, gift: 0 };

for (const path of PATHS) {
  console.log('\n########## ' + path);
  let total = 0, fan = 0, gift = 0;
  for (const m of sample) {
    const r = await fetchPages(path, m, TOKEN, PAGES);
    if (!r.ok) { console.log(`  ${m.n} 失败：${r.err}`); continue; }
    const types = new Map();
    let g = 0, f = 0;
    for (const x of r.list) {
      const t = String(x.msgType || 'TEXT');
      types.set(t, (types.get(t) || 0) + 1);
      let ext = {};
      try { ext = typeof x.extInfo === 'string' ? JSON.parse(x.extInfo) : (x.extInfo || {}); } catch (e) { ext = {}; }
      const role = Number(ext.channelRole);
      if (role !== 2) f++;
      if (t === 'GIFT_TEXT') {
        g++;
        let ct = {};
        try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch (e) { ct = {}; }
        const gi = ct.giftInfo || {};
        const name = String(gi.giftName || '');
        giftNames.set(name, (giftNames.get(name) || 0) + 1);
        const pk = String(gi.giftId) + '|' + name;
        giftPairs.set(pk, (giftPairs.get(pk) || 0) + 1);
        if (giftSamples.length < 8) {
          giftSamples.push({
            member: m.n, memberId: m.id,
            senderId: (ext.user && ext.user.userId) || null,
            senderNick: (ext.user && (ext.user.nickname || ext.user.nickName)) || null,
            role, msgTime: x.msgTime,
            giftName: name, giftNum: gi.giftNum, giftId: gi.giftId,
            acceptUserName: gi.acceptUserName, userName: gi.userName,
          });
        }
      }
    }
    total += r.list.length; fan += f; gift += g;
    console.log(`  ${m.n}(uid=${m.id}) 取回 ${r.list.length} 条 → 粉丝/非房主 ${f} / 礼物 ${g} | nextTime=${r.next}`);
    console.log(`     类型 ${JSON.stringify([...types.entries()].sort((a, b) => b[1] - a[1]))}`);
  }
  console.log(`  —— 合计 ${total} 条：非房主 ${fan} / GIFT_TEXT ${gift}`);
  grand = { msgs: grand.msgs + total, fan: grand.fan + fan, gift: grand.gift + gift };
}

console.log('\n===== 汇总 =====');
console.log(`两个接口合计 ${grand.msgs} 条：非房主 ${grand.fan} / GIFT_TEXT ${grand.gift}`);
console.log('礼物名 TOP：' + JSON.stringify([...giftNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)));
console.log('含「弦月」的礼物：' + JSON.stringify([...giftNames.keys()].filter((n) => n.indexOf('弦月') >= 0)));
console.log('(giftId|name) 全量：' + JSON.stringify([...giftPairs.entries()]));
// 活动打分道具的特征：giftId 是 6 位且以 888 开头（正常礼物都是 18~19 位）
const act = [...giftPairs.keys()].filter((k) => /^88\d{4}\|/.test(k));
console.log('★ 6 位 888xxx 活动道具：' + JSON.stringify(act));
console.log('\nGIFT_TEXT 样本：');
for (const s of giftSamples) console.log('  ' + JSON.stringify(s));
