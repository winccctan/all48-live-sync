/**
 * 直播弹幕 → 礼物记录 的解析（纯函数，不碰网络，方便单测）
 *
 * 为什么单独抽出来：
 *   云信 NIM 里口袋48 的自定义消息**没有官方结构文档**，字段名随版本变，
 *   只能「结构化字段优先 + 文本正则兜底」双保险。这块逻辑最容易出错，
 *   也最需要能脱离网络反复验证（沙箱里跑不了长连接，但能跑纯函数）。
 */

const RE_TARGET = /送给\s*([A-Za-z0-9\u4e00-\u9fa5·\-]{1,24})/;
const RE_NUM = /(\d{1,6})\s*个/;
const RE_SENDER = /^([^\s:：]{1,30}?)\s*(?:送给|送給)/;
const RE_TAIL = /(\d{1,6}|[一二三四五六七八九十两]{1,3})\s*个\s*([^\s,，。"'）)】\]]{1,24})/;

/** 递归摊平对象里所有字符串（别写死路径：同一条消息不同版本套的层数不一样） */
export function flattenStrings(x, out = [], depth = 0) {
  if (depth > 8 || out.length > 300 || x == null) return out;
  if (typeof x === 'string') { if (x) out.push(x); return out; }
  if (Array.isArray(x)) { for (const v of x) flattenStrings(v, out, depth + 1); return out; }
  if (typeof x === 'object') { for (const k of Object.keys(x)) flattenStrings(x[k], out, depth + 1); }
  return out;
}

/** 按 key 名在对象里找第一个命中（浅层优先） */
export function findKey(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return undefined;
  for (const k of Object.keys(obj)) {
    if (keys.indexOf(k) >= 0) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') {
      const hit = findKey(v, keys, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** content 可能是对象，也可能是 JSON 字符串；统一成对象 */
function asObj(x) {
  if (!x) return null;
  if (typeof x === 'string') {
    const t = x.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return JSON.parse(t); } catch { return null; }
    }
    return null;
  }
  return typeof x === 'object' ? x : null;
}

function safeJson(x) {
  try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return ''; }
}

/** 消息正文（text / content / attach 三种放法都试） */
export function bodyOf(m, depth = 0) {
  if (!m || typeof m !== 'object' || depth > 6) return '';
  if (typeof m.text === 'string' && m.text) return m.text;
  if (typeof m.content === 'string' && m.content) return m.content;
  if (m.content && typeof m.content === 'object') return safeJson(m.content);
  if (m.attach && typeof m.attach === 'object') return safeJson(m.attach);
  return '';
}

/**
 * @param {{name:string, ids:Set<string>|string[]}} target  目标礼物
 * @param {Map<string,number>} rosterByName                 成员昵称 → uid
 */
export function createGiftParser(target, rosterByName) {
  const NAME = String((target && target.name) || '').trim();
  const IDS = new Set([...((target && target.ids) || [])].map(String).filter(Boolean));

  /** 「SNH48-杨秋野」/「杨秋野」/「SNH48 TEAM HII 杨秋野」→ uid */
  function memberUid(raw) {
    let s = String(raw || '').trim().replace(/\s+/g, '');
    if (!s) return 0;
    const hit = /^[A-Za-z0-9]+-(.+)$/.exec(s);
    const cands = [];
    if (hit) cands.push(hit[1].trim());
    cands.push(s);
    for (const c of cands) {
      if (!rosterByName) continue;
      const id = rosterByName.get(c);
      if (id) return id;
    }
    // 「SNH48 TEAM HII 某某」这类带前缀的，退一步只比结尾
    for (const c of cands) {
      if (!rosterByName) continue;
      for (const [name, id] of rosterByName) {
        if (name.length >= 2 && c.endsWith(name)) return id;
      }
    }
    return 0;
  }

  /**
   * @param {object} m    NIM onmsg 的消息对象
   * @param {{nick?:string}} room 所在直播间（兜底「送给谁」）
   * @returns {null | {t,mid,sid,sn,gid,g,num,_to,_raw}}
   */
  function parse(m, room) {
    if (!m || (!NAME && !IDS.size)) return null;

    // 🔴 content 可能是对象，也可能是一坨 JSON 字符串（口袋自定义消息最常见），必须先归一
    const obj = asObj(m.content) || asObj(m.attach) || {};
    let raw = bodyOf(m);
    const hay = raw + (m.fromNick ? '|' + m.fromNick : '');
    let hit = (NAME && hay.indexOf(NAME) >= 0) || [...IDS].some((id) => id && hay.indexOf(id) >= 0);

    // content 是对象但 bodyOf 已序列化过；万一还是没命中，摊平再找一次（深层嵌套）
    if (!hit && Object.keys(obj).length) {
      const joined = flattenStrings(obj).join(' ');
      if ((NAME && joined.indexOf(NAME) >= 0) || [...IDS].some((id) => id && joined.indexOf(id) >= 0)) {
        hit = true;
        if (!raw) raw = joined;
        else raw = raw + ' ' + joined;
      }
    }
    if (!hit) return null;

    // 时间：NIM 给的是服务器毫秒；给了秒就换算
    let t = Number(m.time || m.timestamp || 0);
    if (t && t < 1e12) t *= 1000;
    if (!t) t = Date.now();

    // 发送者
    let sn = String(m.fromNick || '').trim();
    let sid = 0;
    const mUid = /(\d{5,12})/.exec(String(m.from || ''));
    if (mUid) sid = Number(mUid[1]);
    const structSid = Number(findKey(obj, ['userId', 'userid', 'uid']) || 0);
    if (structSid && structSid < 1e10) sid = structSid;

    // 送给谁
    let to = String(findKey(obj, ['acceptUserName', 'acceptNickname', 'acceptName', 'toNick', 'toName']) || '').trim();
    if (!to) {
      const h = RE_TARGET.exec(raw);
      if (h) to = h[1];
    }
    if (!to && room && room.nick) to = room.nick;

    // 几个
    let num = Number(findKey(obj, ['giftNum', 'giftnum', 'giftCount', 'count', 'num']) || 0);
    if (!num) {
      const h = RE_NUM.exec(raw);
      num = Number(h && h[1]) || 1;
    }
    num = Math.max(1, Math.min(999999, Math.floor(num)));

    // 礼物名 / giftId
    let gname = String(findKey(obj, ['giftName', 'giftname']) || '').trim();
    if (!gname) {
      const h = RE_TAIL.exec(raw);
      if (h) gname = h[2].trim();
    }
    if (!gname && NAME && raw.indexOf(NAME) >= 0) gname = NAME;
    let gid = String(findKey(obj, ['giftId', 'giftid']) || '');

    // 文本兜底里可能把「弦月回响」后面的标点带进来，清一下
    if (gname && NAME && gname.indexOf(NAME) >= 0) gname = NAME;
    // 正则抓到的「礼物名」如果是一串纯数字，那其实是 giftId，不是名字
    if (gname && /^[0-9]{6,}$/.test(gname)) gname = '';

    // 只写了 giftId 没写礼物名（有的消息体只有 id）：用站点下发的白名单反认
    if (!gid && IDS.size) {
      for (const id of IDS) { if (id && raw.indexOf(id) >= 0) { gid = id; break; } }
    }

    if (!sn) {
      const h = RE_SENDER.exec(raw);
      if (h) sn = h[1];
    }

    // 二次确认：名字或 id 必须真命中
    const byName = !!NAME && (gname.indexOf(NAME) >= 0 || raw.indexOf(NAME) >= 0);
    if (!byName && !IDS.has(gid)) return null;

    // 🔴 形态确认（这条防的是「弦月回响好好听」这类闲聊被误计分）：
    //    必须至少满足一个「礼物播报」的形态
    //    ① 结构化字段里有 giftInfo 痕迹
    //    ② 文本是「N个<礼物名>」
    //    ③ 文本是「送给 X + N个」
    const structMark = findKey(obj, ['giftName', 'giftname', 'giftNum', 'giftnum', 'acceptUserName', 'acceptUserId']);
    const hasStruct = structMark !== undefined && structMark !== null && String(structMark) !== '';
    const textGift = !!gname && RE_TAIL.test(raw);
    //    「送给X 弦月回响」这种不带数量的写法也算（数量按 1 记）
    const textSend = /送给/.test(raw) && (/(\d+|[一二三四五六七八九十两])\s*个/.test(raw) || byName);
    if (!hasStruct && !textGift && !textSend) return null;

    return {
      t,
      mid: memberUid(to),
      sid,
      sn: sn.slice(0, 40),
      gid,
      g: gname || NAME,
      num,
      _to: to,
      _raw: raw.slice(0, 300),
    };
  }

  return { parse, memberUid };
}
