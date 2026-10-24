/*
 * 一次性探针 v3：在播场次的实时弹幕通道。
 *
 * v2 的发现：status=2（在播 / 刚开）的场次，getLiveOne **不返回 msgFilePath**，
 * 只有 status=3（已结束）才有 —— 弹幕 LRC 是直播结束后才落地的。
 * 但在播场次返回了 danMuInfo / systemMsg / roomId（NIM 直播间 id）等字段，
 * 本探针把它们的真实内容打出来，判断有没有「不用等结束」的实时礼物通道。
 *
 * 只读，不上报。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const log = (...a) => console.log(...a);

const r = await postJson('/live/api/v1/live/getLiveList', {
  debug: true, next: '0', record: false,
}, { token: TOKEN, retries: 2 });

const list = (r && r.content && r.content.liveList) || [];
log(`record=false → ${list.length} 场\n`);

for (const x of list.slice(0, 6)) {
  const liveId = String(x.liveId);
  const nick = (x.userInfo && x.userInfo.nickname) || '?';
  const when = new Date(Number(x.ctime || 0)).toISOString().slice(0, 16).replace('T', ' ');
  log(`===== ${when} ${liveId} ${nick} status=${x.status} =====`);
  let c = null;
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId }, { token: TOKEN, retries: 1 });
    c = (d && d.content) || {};
  } catch (e) {
    log('  getLiveOne 失败 ' + String(e.message).slice(0, 80));
    continue;
  }
  for (const k of ['roomId', 'onlineNum', 'status', 'liveMode', 'msgFilePath', 'danMuInfo', 'systemMsg', 'topUser']) {
    if (!(k in c)) { log(`  ${k}: (无此字段)`); continue; }
    const v = c[k];
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.length > 500) s = s.slice(0, 500) + `…(${String(typeof v === 'object' ? JSON.stringify(v).length : v.length)}字符)`;
    log(`  ${k}: ${s}`);
  }
  log('');
}
log('（探针 v3 结束）');
