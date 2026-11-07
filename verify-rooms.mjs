#!/usr/bin/env node
/**
 * 名册房间号体检（每周一次）—— 2026-11-07 站长「加吧」
 * =====================================================================
 * 起因：站长问「为啥没有抓到林舒晴的数据」。查下来不是抓取挂了，是她名册里的
 *   `ch`（channelId）从 10-25 起就是 CKG 时期的老房间号（1360914），
 *   抓取端每天老老实实进那个空房间翻页 ⇒ 一条礼物都没有，
 *   表现和「她最近没活动」一模一样，10 天没人发现（丢了 21 万鸡腿）。
 *
 * 名册的房间号只在手动跑 `sync-roster.mjs --write` 时才会刷新，**没有任何定时校验**，
 * 而 Actions 里改不了静态 members.js（那要重新 deploy 生产）。所以这条通道走 KV：
 *   ① 读站点 `/data/members.js`（已经合并了官方表 + roster:extra）
 *   ② 对每个有房间的人 `im/server/jump` 拿**当前** serverId/channelId
 *   ③ 只处理「不一致、且新房间真能拉到消息」的人 —— 新房间也空的（多半是离团/空壳）不动
 *   ④ `POST /api/roster/extra` 推一行带 fix 标记：`[uid,name,'','',at,srv,ch,1]`
 *      （团队字段传空 ⇒ 一个字都不改；worker 侧见 applyRosterExtra 的 fix 分支）
 *
 * 🔴 只改房间号，绝不碰分数、团、队。改完抓取端下一轮自动用新房间，不用重新部署。
 * 🔴 修好之后每次体检都会继续推同一行（保活），worker 侧 fix 行也不参与 30 天淘汰。
 *
 * 用法：
 *   node verify-rooms.mjs                # 体检 + 推修复
 *   DRY=1 node verify-rooms.mjs          # 只报告，一个字都不推
 *   ONLY_UIDS=614756,63566 node ...      # 只查指定成员（调试）
 *   CONC=6 PAGES=1                       # 并发 / 新房间验证翻几页
 */
import { postJson, fetchMessagePage } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const TOKEN = process.env.POCKET48_TOKEN || '';
const CONC = Math.max(1, Number(process.env.CONC || 6));
const DRY = !!process.env.DRY;
const ONLY = new Set(
  String(process.env.ONLY_UIDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean)
);
const BJ = 8 * 3600 * 1000;
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().replace('T', ' ').slice(0, 19), ...a);

if (!TOKEN) {
  console.error('缺少 POCKET48_TOKEN');
  process.exit(1);
}

/* ---------------------------------------------------------------- ① 名册 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const txt = await (await fetch(SITE + '/data/members.js', { headers: { 'User-Agent': UA } })).text();
const all = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const mem = all.filter((m) => m && m.id && m.srv && m.ch && String(m.tm || '').indexOf('荣誉') < 0);
const targets = ONLY.size ? mem.filter((m) => ONLY.has(Number(m.id))) : mem;
log(`名册 ${all.length} 人 · 有房间 ${mem.length} · 本轮体检 ${targets.length}（并发 ${CONC}）`);

/* ---------------------------------------------------- ② 逐人核对当前房间 */
async function jump(uid) {
  const j = await postJson('/im/api/v1/im/server/jump', { tabId: 0, targetType: 1, starId: uid }, { token: TOKEN, retries: 2 });
  const c = j.content || {};
  return { srv: Number(c.serverId) || 0, ch: Number(c.channelId) || 0 };
}

/** 新房间真能拉到消息才算「活房间」，否则不动（避免把一个暂时空掉的新号写进去） */
async function roomHasMsg(srv, ch) {
  try {
    const r = await fetchMessagePage({ serverId: srv, channelId: ch, nextTime: 0, limit: 5, token: TOKEN, scope: 'all' });
    return (r.messages || []).length;
  } catch {
    return -1;
  }
}

let idx = 0;
const ok = [];
const moved = [];   // 变了但新房间也空
const gone = [];    // jump 拿不到房间
const failed = [];
const fixes = [];   // 要修（或保活）

async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= targets.length) return;
    const m = targets[i];
    try {
      const j = await jump(m.id);
      if (!j.srv || !j.ch) {
        gone.push(m);
        continue;
      }
      if (j.srv === Number(m.srv) && j.ch === Number(m.ch)) {
        ok.push(m);
        continue;
      }
      const n = await roomHasMsg(j.srv, j.ch);
      const rec = { ...m, srv0: m.srv, ch0: m.ch, srv: j.srv, ch: j.ch, msgs: n };
      if (n > 0) fixes.push(rec);
      else moved.push(rec);
    } catch (e) {
      failed.push({ ...m, err: String((e && e.message) || e).slice(0, 60) });
    }
    if ((ok.length + gone.length + fixes.length + moved.length + failed.length) % 100 === 0) {
      log(`  进度 ${ok.length + gone.length + fixes.length + moved.length + failed.length}/${targets.length}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, targets.length) }, worker));

log(`核对完成：正常 ${ok.length} · 要修 ${fixes.length} · 变了但新房间空 ${moved.length} · 无房间 ${gone.length} · 失败 ${failed.length}`);
for (const f of fixes) log(`  ⟳ ${f.n}(${f.id}) ${f.g}/${f.tm}  ${f.srv0}/${f.ch0} → ${f.srv}/${f.ch}  新房间 ${f.msgs} 条`);
for (const f of moved) log(`  · ${f.n}(${f.id}) 名册 ${f.srv0}/${f.ch0} → jump ${f.srv}/${f.ch}（新房间也空，不动）`);

/* 🔴 防「假成功」：口袋里 token 过期 / 出口 IP 被拦时，jump 会全抛异常或全返回空，
   脚本会一路跑到「没有要修的，收工」然后 success —— 等于这条体检通道静默死掉，
   正是林舒晴这种事故最怕的形态。所以异常比例过高就直接判失败，让 Actions 变红。 */
const total = targets.length;
if (total && failed.length + gone.length > total * 0.9) {
  console.error(
    `✖ 异常：${failed.length} 个失败 + ${gone.length} 个拿不到房间 = ${failed.length + gone.length}/${total}，` +
    '疑似 POCKET48_TOKEN 失效或出口被拦，本轮结果不可信'
  );
  if (failed.length) console.error('  首个错误：' + JSON.stringify(failed[0]).slice(0, 200));
  process.exit(2);
}

/* ------------------------------------------------------------ ③ 推修复行 */
if (!fixes.length) {
  log('没有要修的，收工');
  process.exit(0);
}
if (DRY) {
  log('[DRY] 不推送。本应推 ' + fixes.length + ' 行：' + JSON.stringify(fixes.slice(0, 5).map((f) => [f.id, f.n, f.srv, f.ch])));
  process.exit(0);
}
if (!INGEST) {
  console.error('缺少 INGEST_TOKEN，无法写入');
  process.exit(1);
}

// 行格式 [uid, name, g, tm, at, srv, ch, fix]
// 🔴 g/tm 传空字符串：worker 的 applyRosterExtra 只在非空时才改团队字段，
//    这里一个字都不碰（IDFT 这类状态还有 KEEP 保护）。
const now = Date.now();
const rows = fixes.map((f) => [Number(f.id), String(f.n || ''), '', '', now, f.srv, f.ch, 1]);
const res = await fetch(SITE + '/api/roster/extra', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
  body: JSON.stringify({ rows }),
});
const out = await res.json().catch(() => ({}));
log(`推送 ${rows.length} 行 → HTTP ${res.status} ` + JSON.stringify(out).slice(0, 200));
if (!res.ok || out.ok === false) process.exit(1);
log('完成。抓取端下一轮就会用新房间号（/data/members.js 2 分钟缓存）。');
