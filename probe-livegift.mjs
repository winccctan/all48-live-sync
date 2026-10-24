/*
 * 一次性探针：直播间礼物（弹幕 LRC 里的系统播报）。
 *
 * 背景：口袋48 的**直播间送礼不进房间 IM**，它被写进每场直播的弹幕 LRC 文件：
 *   POST /live/api/v1/live/getLiveOne {liveId} -> content.msgFilePath  (LRC 地址)
 *   LRC 行格式： [00:04:05.600]昵称<TAB>送给SNH48-某某 1个瓶装桂花
 * 这套链路在王语晨补档站已验证（scripts/build-live-gifts.mjs），本次探针要回答三件事：
 *   1) 全团近期直播里，「弦月回响」到底有没有在直播间出现（活动分到底算不算直播侧）
 *   2) target 字段的写法（是「SNH48-王语晨」还是纯昵称），决定成员归户怎么做
 *   3) 弹幕里有没有送礼人 uid（预期没有，只有昵称）——决定送礼人榜要不要靠昵称反查
 *
 * 只读，不上报，不写站点。
 * 必须跑在 GitHub Actions（配国内代理 SCRAPE_PROXY）：口袋48 对海外 IP 一律 403。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const LIVES = Math.max(1, Number(process.env.PLIVE_LIVES || 12));   // 最多看几场
const LRC_CAP = Number(process.env.PLIVE_LRC_CAP || 400000);         // 单个 LRC 最多读多少字符

const log = (...a) => console.log(...a);

/** 全团直播列表（含录播）。按 next 翻页，拿到最近若干场。 */
async function listLives(want) {
  const out = [];
  let next = '0';
  for (let page = 0; page < 6 && out.length < want; page++) {
    let r;
    try {
      r = await postJson('/live/api/v1/live/getLiveList', {
        debug: true, next: String(next), record: true,
      }, { token: TOKEN, retries: 2 });
    } catch (e) {
      log('  列表请求失败：' + String(e.message).slice(0, 120));
      break;
    }
    const list = (r && r.content && r.content.liveList) || [];
    if (!list.length) break;
    for (const x of list) {
      if (!x || !x.liveId) continue;
      out.push({
        liveId: String(x.liveId),
        uid: String((x.userInfo && x.userInfo.userId) || ''),
        nick: String((x.userInfo && x.userInfo.nickname) || ''),
        title: String(x.title || ''),
        status: Number(x.status),
        ctime: Number(x.ctime || 0),
      });
      if (out.length >= want) break;
    }
    const nn = (r && r.content && r.content.next) || '0';
    if (!nn || String(nn) === String(next) || String(nn) === '0') break;
    next = String(nn);
  }
  return out;
}

/* 礼物播报行。两种写法都试：官方目前用 TAB 分隔昵称与「送给」。 */
const RE_TAB = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+?)\t\s*送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;
const RE_SP = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]\s*(.+?)\s{2,}送给\s*(.+?)\s+(\d+)\s*个\s*(.+?)\s*$/;

const giftNames = new Map();     // 礼物名 -> 条数
const targets = new Map();       // 送给谁 -> 条数
const nicks = new Set();         // 送礼人昵称
const hitRows = [];              // 命中的「弦月回响」原始条目
const rawSample = [];            // 原始行样本（确认格式）
let totalLines = 0, giftLines = 0, liveOk = 0, liveNoLrc = 0;

const lives = await listLives(LIVES);
log(`取到直播 ${lives.length} 场\n`);

for (const lv of lives) {
  const when = lv.ctime ? new Date(lv.ctime).toISOString().slice(0, 16).replace('T', ' ') : '?';
  let url = '';
  try {
    const d = await postJson('/live/api/v1/live/getLiveOne', { liveId: lv.liveId }, { token: TOKEN, retries: 1 });
    const c = (d && d.content) || {};
    url = c.msgFilePath || '';
    // 顺手记录：接口里还有哪些字段（也许别的字段更适合）
    if (!url) {
      const keys = Object.keys(c).filter((k) => /msg|path|file|chat|lrc/i.test(k));
      log(`  ${when} ${lv.liveId} ${lv.nick} 无 msgFilePath（相关字段：${keys.join(',') || '无'}）`);
      liveNoLrc++;
      continue;
    }
  } catch (e) {
    log(`  ${when} ${lv.liveId} getLiveOne 失败 ${String(e.message).slice(0, 80)}`);
    liveNoLrc++;
    continue;
  }

  let text = '';
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    text = await res.text();
  } catch (e) {
    log(`  ${when} ${lv.liveId} LRC 下载失败 ${String(e.message).slice(0, 80)}`);
    liveNoLrc++;
    continue;
  }
  if (text.length > LRC_CAP) text = text.slice(0, LRC_CAP);

  const lines = text.split('\n');
  totalLines += lines.length;
  let g = 0;
  for (const line of lines) {
    if (!line) continue;
    if (rawSample.length < 6 && line.indexOf('送给') >= 0) rawSample.push(line.trim().slice(0, 160));
    let m = line.match(RE_TAB) || line.match(RE_SP);
    if (!m) continue;
    const [, , nick, target, num, gift] = m;
    const gn = gift.trim();
    giftNames.set(gn, (giftNames.get(gn) || 0) + 1);
    targets.set(target.trim(), (targets.get(target.trim()) || 0) + 1);
    nicks.add(nick.trim());
    g++;
    if (gn.indexOf('弦月') >= 0) {
      hitRows.push({ liveId: lv.liveId, when, member: lv.nick, nick: nick.trim(), target: target.trim(), num: Number(num), gift: gn });
    }
  }
  giftLines += g;
  if (g) liveOk++;
  log(`  ${when} ${lv.liveId} ${lv.nick}（${lv.status === 3 ? '已结束' : '在播中'}）行 ${lines.length} 礼物 ${g}`);
}

log(`\n===== 汇总 =====`);
log(`场次 ${lives.length} | 有礼物播报 ${liveOk} | 无 LRC/失败 ${liveNoLrc}`);
log(`弹幕总行数 ${totalLines} | 礼物行 ${giftLines} | 唯一送礼人昵称 ${nicks.size}`);
log(`\n── 礼物名 TOP20 ──`);
for (const [n, c] of [...giftNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  log(`  ${String(c).padStart(5)}  ${n}`);
}
log(`\n含「弦月」的礼物：${JSON.stringify([...giftNames.keys()].filter((n) => n.indexOf('弦月') >= 0))}`);
log(`\n── 送给谁 TOP12（看 target 写法）──`);
for (const [n, c] of [...targets.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  log(`  ${String(c).padStart(5)}  ${n}`);
}
log(`\n── 原始「送给」行样本 ──`);
rawSample.forEach((l) => log('  ' + l));
log(`\n── 弦月回响 命中 ${hitRows.length} 条 ──`);
hitRows.slice(0, 40).forEach((r) => log(`  ${r.when} ${r.member} ← ${r.nick} ${r.num}个 ${r.gift}`));
log('\n（探针结束）');
