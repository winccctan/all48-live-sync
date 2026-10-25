/**
 * 探测：公演场次的聊天室能不能拉到礼物消息（决定「进行中公演鸡腿」走哪条路）
 *   set -a && source nim-sync.env && set +a
 *   node probe-perf-room.mjs
 */
import { fetchMessagePage, postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

const GROUPS = [
  { id: 10, name: 'SNH48' }, { id: 11, name: 'BEJ48' }, { id: 12, name: 'GNZ48' },
  { id: 14, name: 'CKG48' }, { id: 21, name: 'CGT48' },
];
const BJ = 8 * 3600e3;
const bj = (t) => (t ? new Date(t + BJ).toISOString().replace('T', ' ').slice(0, 16) : '-');

// 1) 各团最近公演（含录播）
const all = [];
for (const g of GROUPS) {
  try {
    const j = await postJson('/live/api/v1/live/getOpenLiveList', { debug: false, groupId: g.id, next: 0, record: true });
    const list = j?.content?.liveList || [];
    for (const it of list) all.push({ ...it, _g: g });
    console.log(`${g.name} 最近 ${list.length} 场`);
  } catch (e) { console.log(`${g.name} 失败`, String(e.message).slice(0, 80)); }
}
all.sort((a, b) => Number(b.stime) - Number(a.stime));
console.log('\n最近 8 场:');
all.slice(0, 8).forEach((x) => console.log(' ', x.liveId, bj(Number(x.stime)), 'status', x.status, (x._g.name + ' ' + (x.title || x.subTitle || '')).slice(0, 40)));

// 2) 拿 roomId
const picks = all.slice(0, 3);
for (const p of picks) {
  try {
    const d = await postJson('/live/api/v1/live/getOpenLiveOne', { liveId: String(p.liveId) });
    const c = d?.content || {};
    console.log('\n场次', p.liveId, bj(Number(p.stime)), 'status', p.status,
      '→ roomId', c.roomId, '| 键', Object.keys(c).slice(0, 18).join(','));
    probeRoom(Number(c.roomId), p);
  } catch (e) { console.log('详情失败', String(e.message).slice(0, 80)); }
}

async function probeRoom(roomId, p) {
  if (!roomId) return console.log('  没有 roomId，跳过');
  for (const srv of [5, 10, 11, 12, 14, 21]) {
    try {
      const r = await fetchMessagePage({ serverId: srv, channelId: roomId, nextTime: 0, limit: 20, token: TOKEN, scope: 'all' });
      if (!r.messages.length) { console.log(`  srv=${srv} 0 条`); continue; }
      let gifts = 0;
      const sample = [];
      for (const x of r.messages) {
        let ct = {};
        try { ct = typeof x.bodys === 'string' ? JSON.parse(x.bodys) : (x.bodys || {}); } catch { }
        const gi = ct.giftInfo || (ct.giftText && ct.giftText.giftInfo);
        if (!gi) continue;
        gifts++;
        if (sample.length < 2) {
          let ext = {};
          try { ext = typeof x.extInfo === 'string' ? JSON.parse(x.extInfo) : (x.extInfo || {}); } catch { }
          sample.push({ t: x.msgTime, g: gi.giftName, num: gi.giftNum, gid: gi.giftId, acc: gi.acceptUser, ext: ext.user && { id: ext.user.userId, n: ext.user.nickname } });
        }
      }
      console.log(`  ✅ srv=${srv} 拉到 ${r.messages.length} 条，其中礼物 ${gifts} 条`);
      if (sample.length) sample.forEach((s) => console.log('     ', JSON.stringify(s)));
      if (gifts) return;
      // 没有礼物也给一条普通消息的字段，方便看结构
      const x = r.messages[0];
      console.log('     首条:', JSON.stringify({ type: x.type, msgTime: x.msgTime, bodys: String(x.bodys).slice(0, 160) }));
      return;
    } catch (e) {
      console.log(`  srv=${srv} 失败 ${String(e.message).slice(0, 70)}`);
    }
  }
}
