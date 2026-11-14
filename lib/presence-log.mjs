/**
 * 在线状态事件 → 会话日志 → 「口袋在线记录」输出
 *
 * 数据源：云信服务端在线状态订阅推送的 eventType=1 事件（value 1/2/3），
 * 由 lib/yunxin-presence.mjs 的 attachToSession() 喂进来。
 *
 * 🔴 口径：这是【云信账号的登录连接状态】，不是「前台打开 App」。
 *    官方说明：App 被清理但厂商推送可达时默认不触发断开事件 → 在线时长会偏长。
 *
 * 🔴 历史只能从【启用订阅那一刻】开始累积，云信不提供历史事件回放，
 *    启用前的记录补不回来。别拿动作推断去混填，两套口径混在一起就废了。
 *
 * 🔴 本文件只存成员 NIM accid（服务端账号），不存任何粉丝身份/uid。
 *    默认落 .cache/presence-log.json（已在 .gitignore 里）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const BJ = 28800000; // 一律锁北京时间：ts + 8h 再取 UTC*
const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_PATH = resolve(ROOT, '.cache/presence-log.json');

/** 分:秒（分钟可 >59，对齐 xox48 的 [30:07]） */
export function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function bjStamp(ts, withSec = false) {
  const d = new Date(Number(ts) + BJ).toISOString();
  return withSec ? `${d.slice(5, 10).replace('-', '-')} ${d.slice(11, 19)}`
                 : `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}
function bjShort(ts) {
  const d = new Date(Number(ts) + BJ).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
}

export function load(path = process.env.PRESENCE_LOG_PATH || DEFAULT_PATH) {
  try {
    if (!existsSync(path)) return { v: 1, members: {} };
    const j = JSON.parse(readFileSync(path, 'utf8'));
    if (j && j.members && typeof j.members === 'object') return j;
  } catch (e) {
    console.error('[presence-log] 读取失败，按空库继续：', e.message);
  }
  return { v: 1, members: {} };
}

export function save(db, path = process.env.PRESENCE_LOG_PATH || DEFAULT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  // 先写临时再改名，避免写一半断电把日志写坏
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(db), 'utf8');
  writeFileSync(path, JSON.stringify(db), 'utf8');
}

function member(db, accid, name) {
  const k = String(accid);
  if (!db.members[k]) {
    db.members[k] = {
      // name 只在显式传入时更新；不把任何粉丝身份写进日志
      name: String(name || '').trim(),
      online: false,
      onT: 0,
      lastT: 0,
      lastKey: '',
      sessions: [],
    };
  } else if (name && String(name).trim()) {
    db.members[k].name = String(name).trim();
  }
  return db.members[k];
}

/**
 * 喂一条在线状态事件。
 * @param {{accid:string, value:1|2|3, time?:number, name?:string}} evt
 * @returns {{changed:boolean, reason:string}}
 */
export function ingest(evt, db = load(), path) {
  const accid = String(evt?.accid || '').trim();
  const value = Number(evt?.value);
  const t = Number(evt?.time) || Date.now();
  if (!accid || ![1, 2, 3].includes(value)) return { changed: false, reason: 'bad-event' };

  const m = member(db, accid, evt.name);
  const key = `${accid}|${value}|${t}`;
  if (key === m.lastKey) return { changed: false, reason: 'duplicate' };
  if (t < m.lastT) return { changed: false, reason: 'out-of-order' };

  m.lastKey = key;
  m.lastT = t;

  if (value === 1) {
    if (m.online) return { changed: false, reason: 'already-online' };
    m.online = true;
    m.onT = t;
    save(db, path || process.env.PRESENCE_LOG_PATH || DEFAULT_PATH);
    return { changed: true, reason: 'login' };
  }

  // value 2=登出 / 3=断开连接
  if (!m.online) return { changed: false, reason: 'already-offline' };
  m.online = false;
  m.sessions.push({ on: m.onT, off: t, value });
  // 只留最近 2000 条，避免无限增长
  if (m.sessions.length > 2000) m.sessions = m.sessions.slice(-2000);
  m.onT = 0;
  save(db, path || process.env.PRESENCE_LOG_PATH || DEFAULT_PATH);
  return { changed: true, reason: value === 2 ? 'logout' : 'disconnect' };
}

/**
 * 渲染成 xox48 那种「在线记录」文案。
 * @returns {string[]} 每行一条，可直接发微信群
 */
export function render(accid, { name, now = Date.now(), limit = 21, page = 1, db = load() } = {}) {
  const k = String(accid);
  const m = db.members[k];
  const who = String(name || m?.name || '该成员').trim();
  const lines = [`${who} 的口袋在线记录:【${page}】页`, `当前时间${bjStamp(now, true)}`];

  if (!m || (!m.sessions.length && !m.online)) {
    lines.push('暂无记录（订阅启用前的历史无法回放）');
    return lines;
  }

  if (m.online) {
    lines.push(`now:🟢在线 [已在线 ${fmtDur(now - m.onT)}]`);
  } else {
    const last = m.sessions[m.sessions.length - 1];
    lines.push(`now:🕑离线 [${fmtDur(now - (last?.off || m.lastT))}前]`);
  }

  const list = [...m.sessions].sort((a, b) => b.on - a.on).slice((page - 1) * limit, page * limit);
  for (const s of list) {
    lines.push(`${bjShort(s.on)}在线 [${fmtDur(s.off - s.on)}]`);
  }
  return lines;
}

/** 给调试/自检用：列出已积累的成员与会话数（不打印 accid 明文） */
export function stats(db = load()) {
  const keys = Object.keys(db.members || {});
  return {
    members: keys.length,
    sessions: keys.reduce((n, k) => n + (db.members[k].sessions?.length || 0), 0),
    onlineNow: keys.filter((k) => db.members[k].online).length,
  };
}
