/**
 * 口袋48「成员在线记录」群机器人回复 → 结构化数据
 *
 * 背景：xox48 类机器人的 /Api/member_online 只放行「群内查询」，HTTP 直连一律
 * {"error":"1","msg":"群内查询","data":[]}。第三方想拿这份数据，唯一现实入口是
 * 拿到**群机器人回复的那段文本**（转发/粘贴皆可），再在这里解析。
 *
 * 不做任何网络请求、不依赖 worker，纯函数，方便单测和离线回放。
 */

const DUR_RE = /^\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(在线|离线|上线|下线)\s*\[\s*(\d+):(\d+)\s*\]\s*$/;
const TITLE_RE = /^\s*(.+?)\s*的口袋在线记录\s*[:：]?\s*【?\s*(\d+)\s*】?\s*页?\s*$/;
const ASOF_RE = /当前时间\s*(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/;
/* 「已在线 [5:22]」没有「前」，是**已在线时长**；「离线 [19:49前]」是**距下线**。
   两者数值都从查询时刻往前减，但语义不同，用 metric 区分，别再把 5:22 显示成「5:22前」。 */
const NOW_RE = /now\s*[:：].*?(已在线|已离线|在线|离线)\s*\[\s*(\d+):(\d+)\s*(前)?\s*\]/i;

const durSec = (m, s) => Number(m) * 60 + Number(s);

/** 北京时间 → epoch ms（北京 = UTC+8，所以减 8 小时；写成 +8 会得到 UTC-8） */
export function bjMs(year, month, day, hour, min, sec = 0) {
  return Date.UTC(year, month - 1, day, hour, min, sec) - 8 * 3600e3;
}

/** 年份推断：查询时刻在 1 月、记录里出现 12 月 ⇒ 上一年。其余同年。 */
function rowYear(asOf, month) {
  return month > asOf.month ? asOf.year - 1 : asOf.year;
}

/**
 * @param {string} text 机器人回复原文（可含多余空行 / 前缀表情）
 * @param {{now?: number}} opts now = 收到这条消息的时间(ms)，用于补年份与 capturedAt
 * @returns {null | {name,page,asOf,asOfText,now,rows,stats,capturedAt}}
 */
export function parseOnlineRecord(text, opts = {}) {
  const src = String(text || '');
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return null;

  let name = '', page = 1;
  for (const l of lines) {
    const m = l.match(TITLE_RE);
    if (m) { name = m[1].trim(); page = Number(m[2]) || 1; break; }
  }
  if (!name) return null;

  const capturedAt = Number(opts.now) || Date.now();
  const cap = new Date(capturedAt + 8 * 3600e3); // 转成北京的日历字段
  let asOf = { year: cap.getUTCFullYear(), month: cap.getUTCMonth() + 1 };
  let asOfMs = capturedAt;
  const am = src.match(ASOF_RE);
  if (am) {
    const [, mo, d, h, mi, ss] = am;
    asOf = { year: rowYear({ year: cap.getUTCFullYear(), month: Number(mo) }, Number(mo)), month: Number(mo) };
    // 「当前时间」给的是月日，年份按收到消息的年份；若月日比今天晚很多（跨年回放）则回退一年
    let y = cap.getUTCFullYear();
    if (Number(mo) > cap.getUTCMonth() + 1) y -= 1;
    asOf.year = y;
    asOfMs = bjMs(y, Number(mo), Number(d), Number(h), Number(mi), Number(ss || 0));
  }

  let now = null;
  const nm = src.match(NOW_RE);
  if (nm) {
    const sinceSec = durSec(nm[2], nm[3]);
    const online = /在线/.test(nm[1]) && !/离线/.test(nm[1]);
    now = {
      online,
      state: nm[1],
      metric: online ? 'online_elapsed' : 'offline_elapsed',
      sinceSec,
      sinceMs: asOfMs - sinceSec * 1000,
      sinceText: `${nm[2]}:${nm[3]}${nm[4] || ''}`,
      hasSuffix: !!nm[4],
    };
  }

  const rows = [];
  for (const l of lines) {
    const m = l.match(DUR_RE);
    if (!m) continue;
    const [, mo, d, h, mi, state, dm, ds] = m;
    const y = rowYear(asOf, Number(mo));
    const ts = bjMs(y, Number(mo), Number(d), Number(h), Number(mi), 0);
    rows.push({
      ts,
      date: `${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      time: `${String(h).padStart(2, '0')}:${mi}`,
      state,
      durSec: durSec(dm, ds),
    });
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.ts - a.ts);

  const ds = rows.map((r) => r.durSec).sort((a, b) => a - b);
  const stats = {
    segments: rows.length,
    totalSec: ds.reduce((a, b) => a + b, 0),
    minSec: ds[0],
    maxSec: ds[ds.length - 1],
    medianSec: ds.length % 2 ? ds[(ds.length - 1) / 2] : Math.round((ds[ds.length / 2 - 1] + ds[ds.length / 2]) / 2),
    // 4:40~4:43 密集段 => 约 5 分钟会话保活超时，不是「主动上线」
    keepaliveLike: ds.filter((x) => x >= 280 && x <= 283).length,
  };

  return {
    name, page,
    asOf: asOfMs,
    asOfText: am ? am[0].replace('当前时间', '').trim() : '',
    now, rows, stats, capturedAt,
  };
}

/** 同一成员的多次快照合并去重：键 = 上线时刻 + 状态 + 时长 */
export function mergeOnlineRecords(existing, parsed, limit = 500) {
  if (!parsed) return existing;
  const old = Array.isArray(existing?.rows) ? existing.rows : [];
  const seen = new Set(old.map((r) => `${r.ts}|${r.state}|${r.durSec}`));
  const rows = old.slice();
  for (const r of parsed.rows) {
    const k = `${r.ts}|${r.state}|${r.durSec}`;
    if (seen.has(k)) continue;
    seen.add(k); rows.push(r);
  }
  rows.sort((a, b) => b.ts - a.ts);
  return {
    name: parsed.name,
    rows: rows.slice(0, limit),
    updatedAt: parsed.capturedAt,
    lastNow: parsed.now || existing?.lastNow || null,
    snapshots: (Number(existing?.snapshots) || 0) + 1,
  };
}

/** 群里回一句人话摘要（不刷屏，只在被问到时用） */
export function summaryOf(rec) {
  if (!rec) return '';
  const h = (s) => {
    const tail = (x) => x % 60 ? `${Math.floor(x / 60)}分${x % 60}秒` : `${Math.floor(x / 60)}分`;
    return s >= 3600 ? `${Math.floor(s / 3600)}小时${tail(s % 3600)}` : tail(s);
  };
  const last = rec.rows[0];
  const nowText = rec.now
    ? (rec.now.online ? `已在线 ${h(rec.now.sinceSec)}` : `离线（${h(rec.now.sinceSec)}前）`)
    : '状态未知';
  return `${rec.name}：现在${nowText}；` +
    `最近上线 ${last.date} ${last.time}，本次快照 ${rec.stats.segments} 段 / 合计 ${h(rec.stats.totalSec)}` +
    `（中位 ${h(rec.stats.medianSec)}，最长 ${h(rec.stats.maxSec)}）`;
}
