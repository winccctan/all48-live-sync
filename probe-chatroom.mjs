/**
 * 探针：直播聊天室历史消息能不能拿到「全量」礼物
 * ---------------------------------------------------------------
 * 想验证的假设：LRC 回放弹幕只是抽样，而 chatroom/msg/list/all
 * 能按 roomId 拉完整历史 ⇒ 用它替代/补齐 LRC。
 *
 * 用法：node probe-chatroom.mjs
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('需要 POCKET48_TOKEN'); process.exit(1); }

const log = (...a) => console.log(...a);

function flat(x, out = [], d = 0) {
  if (d > 6 || !x) return out;
  if (typeof x === 'string') { if (x) out.push(x); return out; }
  if (Array.isArray(x)) { for (const v of x) flat(v, out, d + 1); return out; }
  if (typeof x === 'object') { for (const k of Object.keys(x)) flat(x[k], out, d + 1); }
  return out;
}

// 1) 拿最近已结束的直播
const lr = await postJson('/live/api/v1/live/getLiveList',
  { debug: true, next: '0', record: true }, { token: TOKEN, retries: 2 });
const list = (lr.content && lr.content.liveList) || [];
log(`已结束直播 ${list.length} 场`);
if (!list.length) process.exit(0);

let tried = 0;
for (const s of list.slice(0, 8)) {
  const liveId = String(s.liveId || '');
  if (!liveId) continue;
  let one;
  try {
    one = (await postJson('/live/api/v1/live/getLiveOne', { liveId }, { token: TOKEN, retries: 2 })).content || {};
  } catch (e) { log(`[${liveId}] getLiveOne 失败 ${e.message.slice(0, 60)}`); continue; }

  const roomId = one.roomId || one.chatroomId || '';
  log(`\n=== liveId=${liveId} nick=${(s.userInfo || {}).nickname} ctime=${one.ctime || s.ctime} roomId=${roomId} ===`);
  log(`  字段样例: ${flat(one).filter((v) => /^\d{5,}$/.test(v)).slice(0, 8).join(' , ')}`);

  if (!roomId) { log('  ⚠️ 没有 roomId，跳过'); continue; }
  tried++;

  // 2) 试 chatroom/msg/list/all
  for (const path of [
    '/im/api/v1/chatroom/msg/list/all',
    '/im/api/v1/chatroom/msg/list/homeowner',
  ]) {
    try {
      const r = await postJson(path, { roomId: String(roomId), nextTime: 0, limit: 100 },
        { token: TOKEN, retries: 1 });
      const c = r.content || {};
      const msgs = c.message || c.messages || [];
      log(`  ${path} → status=${r.status} msgs=${msgs.length} nextTime=${c.nextTime ?? '-'}`);
      if (msgs.length) {
        // 找 GIFT_TEXT
        let gifts = 0;
        const samples = [];
        for (const m of msgs) {
          const txt = flat(m).join(' | ');
          if (/弦月回响|送给/.test(txt)) { gifts++; if (samples.length < 3) samples.push(txt.slice(0, 160)); }
        }
        log(`    含送礼字样 ${gifts} 条`);
        samples.forEach((s) => log('    例: ' + s));
        log('    首条原始: ' + JSON.stringify(msgs[0]).slice(0, 400));
      }
    } catch (e) {
      log(`  ${path} → 失败 ${String(e.message).slice(0, 140)}`);
    }
  }
  if (tried >= 3) break;
}
log('\n探测结束');
