/*
 * 一次性探针 v2：直播间的「弦月回响」到底有没有。
 *
 * v1 的教训：只拉了 record:true（已结束录播），最新一批是 10-23 的场次，
 * 而房间侧的「弦月回响」全部落在 10-24 14:34 之后 —— 纯时间差，v1 结论无效。
 *
 * v2 改法：
 *   1) 同时拉 record:false（含在播 / 刚结束的场次）
 *   2) 按 ctime 过滤，只看最近 HOURS 小时内开的场
 *   3) 打印 getLiveOne 返回的全部字段名（找有没有比 LRC 更实时的礼物来源）
 *   4) 在播中的 LRC 可能是增量写的，单独标注，便于判断「要不要等直播结束再扫」
 *
 * 只读，不上报。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const HOURS = Math.max(1, Number(process.env.PLIVE_HOURS || 8));   // 只看最近几小时内开的场
const MAX = Math.max(1, Number(process.env.PLIVE_MAX || 30));
const log = (...a) => console.log(...a);

/** 拉一份直播列表（record 由调用方定），返回去重后的场次 */
async function listLives(record) {
  const out = [];
  let next = '0';
  for (let page = 0; page < 8; page++) {
    let r;
    try {
      r = await postJson('/live/api/v1/live/getLiveList', {
        debug: true, next: String(next), record,
      }, { token: TOKEN, retries: 2 });
    } catch (e) {
      log(`  列表(record=${record})请求失败：` + String(e.message).slice(0, 120));
      break;
    }
    const c = (r && r.content) || {};
    const list = Array.isArray(c.liveList) ? c.liveList : [];
    if (!list.length) break;
    for (const x of list) {
      if (!x || !x.liveId) continue;
      out.push({
        liveId: String(x.liveId),
        uid: String((x.userInfo && x.userInfo.userId) || ''),
        nick: String((x.userInfo && x.userInfo.nickname) || ''),
        status: Number(x.status),
        ctime: Number(x.ctime || 0),
        record: !!record,
      });
    }
    const nn = c.next;
    if (nn == null || String(nn) === '0' || String(nn) === String(next)) break;
    next = String(nn);
  }
  return out;
}

const RE_TAB = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const RE_SP = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+?)\s{2,}送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;

const since = Date.now() - HOURS * 3600 * 1000;

const merged = new Map();
for (const rec of [false, true]) {
  const got = await listLives(rec);
  for (const lv of got) {
    const k = lv.liveId;
    if (!merged.has(k)) merged.set(k, lv);
    else if (lv.record) merged.get(k).record = true;
  }
  log(`列表 record=${rec} → ${got.length} 场（累计去重 ${merged.size}）`);
}

const all = [...merged.values()].sort((a, b) => b.ctime - a.ctime);
const recent = all.filter((x) => x.ctime >= since).slice(0, MAX);
log(`\n最近 ${HOURS} 小时内开的场：${recent.length} 场（总 ${all.length} 场）`);
if (all.length) {
  const t = all[0].ctime;
  log(`  最新一场：${new Date(t).toISOString().slice(0, 16).replace('T', ' ')}Z  ${all[0].nick}  status=${all[0].status}`);
}

let fieldsShown = 0;
const giftNames = new Map();
const targets = new Map();
const hits = [];
let totalLines = 0, giftLines = 0, noLrc = 0, liveOnair = 0;

for (const lv of recent) {
  const when = new Date(lv.ctime).toISOString().slice(0, 16).replace('T', ' ');
  const tag = lv.status === 3 ? '已结束' : (lv.status === 1 ? '在播中' : 'status=' + lv.status);
  if (lv.status === 1) liveOnair++;

  let c = null;
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: lv.liveId }, { token: TOKEN, retries: 1 });
    c = (d && d.content) || {};
  } catch (e) {
    log(`  ${when} ${lv.liveId} ${lv.nick} getLiveOne 失败 ${String(e.message).slice(0, 70)}`);
    noLrc++;
    continue;
  }
  if (fieldsShown < 3) {
    log(`  [字段] getLiveOne content keys = ${Object.keys(c).join(',')}`);
    fieldsShown++;
  }
  const url = c.msgFilePath || '';
  if (!url) {
    log(`  ${when} ${lv.liveId} ${lv.nick}（${tag}）无 msgFilePath`);
    noLrc++;
    continue;
  }
  let text = '';
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    log(`  ${when} ${lv.liveId} ${lv.nick}（${tag}）LRC 下载失败 ${String(e.message).slice(0, 60)}`);
    noLrc++;
    continue;
  }
  const lines = text.split('\n');
  totalLines += lines.length;
  let g = 0;
  for (const line of lines) {
    if (!line) continue;
    const m = line.match(RE_TAB) || line.match(RE_SP);
    if (!m) continue;
    const [, , nick, target, num, gift] = m;
    const gn = gift.trim();
    giftNames.set(gn, (giftNames.get(gn) || 0) + 1);
    targets.set(target.trim(), (targets.get(target.trim()) || 0) + 1);
    g++;
    if (gn.indexOf('弦月') >= 0) {
      hits.push({ liveId: lv.liveId, when, member: lv.nick, nick: nick.trim(), num: Number(num), gift: gn });
    }
  }
  giftLines += g;
  log(`  ${when} ${lv.liveId} ${lv.nick}（${tag}）行 ${lines.length} 礼物 ${g}`);
}

log(`\n===== 汇总 =====`);
log(`场次 ${recent.length}（在播 ${liveOnair}）| 无 LRC ${noLrc}`);
log(`弹幕总行数 ${totalLines} | 礼物行 ${giftLines}`);
log(`\n── 礼物名 TOP25 ──`);
for (const [n, c] of [...giftNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  log(`  ${String(c).padStart(5)}  ${n}`);
}
log(`\n含「弦月」：${JSON.stringify([...giftNames.keys()].filter((n) => n.indexOf('弦月') >= 0))}`);
log(`\n── 送给谁 TOP12 ──`);
for (const [n, c] of [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  log(`  ${String(c).padStart(5)}  ${n}`);
}
log(`\n── 弦月回响 命中 ${hits.length} 条 ──`);
hits.slice(0, 60).forEach((r) => log(`  ${r.when} ${r.member} ← ${r.nick} ${r.num}个 ${r.gift}`));
log('\n（探针 v2 结束）');
