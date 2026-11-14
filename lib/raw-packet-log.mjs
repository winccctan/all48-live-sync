/**
 * 云信全包「脱敏取证」记录器
 * =====================================================================
 * 目的：把 qchat.cjs / chatroom.cjs 透传出来的所有包，压成可长期挂机的紧凑证据。
 *
 * 🔴 隐私铁律（站长口径，勿改）：
 *   · 绝**不**记录 body 原文、accid、uid、昵称、消息文本、token。
 *   · 只记：时间、层、serviceId/commandId、resultCode、body 长度、关键词**是否命中**。
 *   · 关键词只用于判断「这个包像不像在线状态通知」，命中也只存词本身。
 *
 * 体积控制：按 (层, serviceId, commandId) 聚合，每 60 秒刷一次聚合行；
 *   每小时一个 .jsonl，单文件超过 4MB 自动停写并告警（绝不无限增长）。
 *
 * 用法：
 *   const rec = createRawRecorder({ label: 'probe' });
 *   const q = createNimCommonlinkQChatClient({ ..., onRawPacket: (l,p,v) => rec.note(l,p,v) });
 *   const c = createNimCommonlinkChatroomClient({ ..., onRawPacket: (p,v) => rec.note('chatroom',p,v) });
 *   ...
 *   rec.close();
 */
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** 只用于判断包类型是否像「在线 / 登录 / 成员状态」通知；命中只存词，不存上下文。 */
const KEYWORDS = [
  'online', 'login', 'logout', 'presence', 'eventtype', 'accid',
  'clienttype', 'kick', 'member', 'status', 'session', 'device',
  'heartbeat', 'subscribe', 'notify', 'enter', 'exit'
];

/** 已知平凡包：心跳/握手/登录/地址/订阅回执/消息/房间信息，不算「新发现」。 */
const TRIVIAL = new Set([
  '1/1', '1/2', '2/2', '24/1', '24/2', '24/11', '25/7',
  '13/2', '13/6', '13/7', '13/13', '13/35',
  '4/1', '4/2', '4/10', '4/11'
]);

/* 已知「非平凡但**不是**在线事件」的包（2026-11-13 主账号全量订阅实测）：
 *   24/14 = QChat 服务器信息变更通知（k=15 JSON: serverInfo{1..17} + type=10/13）
 *   24/26 = QChat 两字段轻通知（k=1 str30 + k=2 num32）
 * 它们仍会被标 ★，但别拿去当「成员上线」解码；真正的在线事件是 14/*，目前抓到 0 个。
 * 之前「75 秒只见心跳」是订阅失败（死房间 / 第二账号无权限），不是服务端不推。 */
export function isCandidatePacket(serviceId, commandId) {
  return !TRIVIAL.has(`${serviceId}/${commandId}`);
}

/** 从二进制 body 里只判断关键词是否出现，不返回任何内容。 */
function hitKeywords(body) {
  if (!body || !body.length) return [];
  const text = body.subarray(0, 4096).toString('utf8').toLowerCase();
  const out = [];
  for (const k of KEYWORDS) if (text.includes(k)) out.push(k);
  return out.slice(0, 8);
}

export function createRawRecorder(options = {}) {
  const dir = resolve(options.dir || '.cache/raw-packets');
  const label = String(options.label || 'raw').replace(/[^a-z0-9_-]/gi, '_');
  const flushMs = Math.max(5000, Number(options.flushMs || 60000));
  const maxBytes = Math.max(1024 * 64, Number(options.maxBytes || 4 * 1024 * 1024));
  const onCandidate = typeof options.onCandidate === 'function' ? options.onCandidate : null;
  const quiet = !!options.quiet;
  let file = '';
  let bytes = 0;
  let stopped = false;
  const agg = new Map();       // 本轮待落盘：flush 后清空
  const total = new Map();     // 全程累计：summary() 用它，不受 flush 影响
  const seenCandidates = new Set();

  try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

  const hourFile = () => {
    const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 13).replace(/[-T]/g, '');
    return resolve(dir, `${label}-${d}.jsonl`);
  };

  function note(layer, packet, via = 'frame') {
    if (!packet) return;   // 落盘满了也继续内存聚合，只是不再写文件
    const s = Number(packet.serviceId) || 0;
    const c = Number(packet.commandId) || 0;
    const key = `${layer}|${s}/${c}`;
    const len = packet.body ? packet.body.length : 0;
    const code = Number(packet.resultCode) || 200;
    const kws = hitKeywords(packet.body);
    for (const map of [agg, total]) {
      let row = map.get(key);
      if (!row) {
        row = { n: 0, first: Date.now(), last: 0, minLen: len, maxLen: len, codes: new Set(), kw: new Set(), via: new Set() };
        map.set(key, row);
      }
      row.n += 1;
      row.last = Date.now();
      row.minLen = Math.min(row.minLen, len);
      row.maxLen = Math.max(row.maxLen, len);
      row.codes.add(code);
      if (via) row.via.add(via);
      for (const k of kws) row.kw.add(k);
    }
    const row = total.get(key);

    if (isCandidatePacket(s, c) && !seenCandidates.has(key)) {
      seenCandidates.add(key);
      if (!quiet) console.log(`  ★ 发现非平凡包 ${layer} ${s}/${c}  len=${len} code=${code}`);
      onCandidate?.({ layer, serviceId: s, commandId: c, len, code, kw: [...row.kw] });
    }
  }

  function flush() {
    if (stopped || !agg.size) return;
    if (!file) { file = hourFile(); bytes = 0; try { bytes = statSync(file).size; } catch { /* ignore */ } }
    if (bytes >= maxBytes) {
      if (!quiet) console.warn(`[raw] ${file} 已达 ${Math.round(bytes / 1024)}KB，停止落盘（内存聚合继续）`);
      stopped = true;
      return;
    }
    const now = Date.now();
    const lines = [];
    for (const [key, row] of agg) {
      const [layer, sc] = key.split('|');
      lines.push(JSON.stringify({
        t: now, layer, sc, n: row.n, first: row.first, last: row.last,
        len: [row.minLen, row.maxLen], code: [...row.codes], via: [...row.via], kw: [...row.kw]
      }));
    }
    const chunk = lines.join('\n') + '\n';
    try {
      appendFileSync(file, chunk);
      bytes += Buffer.byteLength(chunk);
    } catch (e) {
      if (!quiet) console.warn('[raw] 落盘失败：' + String(e.message).slice(0, 100));
      stopped = true;
      return;
    }
    agg.clear();
  }

  const timer = setInterval(flush, flushMs);
  timer.unref?.();

  /** 打印当前窗口的包谱（不落盘内容，只有聚合数字）。 */
  function summary() {
    const rows = [];
    for (const [key, row] of total) {
      const [layer, sc] = key.split('|');
      const [s, c] = sc.split('/').map(Number);
      rows.push({
        layer, sc, n: row.n, len: [row.minLen, row.maxLen],
        code: [...row.codes].join('/'), kw: [...row.kw].join(','),
        via: [...row.via].join('/'), candidate: isCandidatePacket(s, c) ? '★' : ''
      });
    }
    return rows.sort((a, b) => b.n - a.n);
  }

  function close() {
    clearInterval(timer);
    flush();
    return { file, bytes, stopped };
  }

  return { note, flush, summary, close, get file() { return file; } };
}
