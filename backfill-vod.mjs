/**
 * 录播（历史回放）全量回填 —— 手动跑一次，把每位成员的录播列表都收进 R2。
 *
 * 为什么单独一个脚本：
 *   sync.mjs 每轮只抓「关注的人 + 分片 N 人」，全员要靠几十轮慢慢覆盖；
 *   新功能刚上线时想要「立刻每个人都有回放」，就跑这个一次。
 *   之后的新增录播由 sync.mjs 的分片轮转接着维护。
 *
 * 用法（GitHub Actions 手动触发 workflow「录播回填」）：
 *   node backfill-vod.mjs
 * 环境变量：
 *   SITE_URL / INGEST_TOKEN / POCKET48_TOKEN / SCRAPE_PROXY
 *   ONLY_FOLLOWED=1  只回填关注的人（快，几十秒）
 *   VOD_PLAY         每人前几条取播放地址（默认 4）
 *   VOD_KEEP         每人保留多少条录播（默认 20）
 *   VOD_CONC         并发（默认 6）
 */
import { fetchLiveListPage, fetchLiveOne, fetchNewestLiveId, pickPlayable } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || '').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const ONLY_FOLLOWED = !!process.env.ONLY_FOLLOWED;
// 为什么原来只有 4 条历史：① 只翻了第一页（20 条）；② 只给前 4 条取了播放地址，
// 没地址的条目前端点不开。现在默认翻 3 页（最多 60 条）+ 前 15 条都取地址。
const VOD_PAGES = Number(process.env.VOD_PAGES || 3);
const VOD_PLAY = Number(process.env.VOD_PLAY || 15);
const VOD_KEEP = Number(process.env.VOD_KEEP || 60);
const CONC = Number(process.env.VOD_CONC || 8);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

if (!SITE) { console.error('缺少 SITE_URL'); process.exit(1); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const t0 = Date.now();

async function site(path, init) {
  const res = await fetch(SITE + path, {
    ...init,
    headers: { 'User-Agent': UA, Accept: 'application/json', ...(init && init.headers) },
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res;
}

/* ---------- 名单 ---------- */
let uids = [];
try {
  const j = await (await site('/api/follow')).json();
  uids = Array.isArray(j.uids) ? j.uids.map(Number).filter(Boolean) : [];
} catch (e) { log('读关注名单失败：' + e.message); }

if (!ONLY_FOLLOWED) {
  try {
    const txt = await (await site('/data/members.js')).text();
    const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
    const seen = new Set(uids);
    for (const m of arr) { const id = Number(m.id); if (id && !seen.has(id)) { seen.add(id); uids.push(id); } }
  } catch (e) { log('读成员目录失败：' + e.message); }
}
log(`回填 ${uids.length} 人`);

/* ---------- 全团最新 liveId：按成员翻页的 next 起点（不能是 0） ---------- */
const newestLiveId = await fetchNewestLiveId({ groupId: 1, record: true });
log('翻页起点 liveId=' + newestLiveId);

/* ---------- 并发抓 ---------- */
let cursor = 0, done = 0, has = 0, batch = [];

async function flush(force) {
  if (!batch.length || (!force && batch.length < 50)) return;
  const send = batch;
  batch = [];
  try {
    const r = await site('/api/vod/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-ingest-token': INGEST },
      body: JSON.stringify(send),
    });
    log(`  已上报 ${done} 人（本批 ${send.length}）`);
  } catch (e) {
    log('  上报失败：' + e.message + '（本批 ' + send.length + ' 人丢弃）');
  }
}

async function worker() {
  for (;;) {
    const i = cursor++;
    if (i >= uids.length) return;
    const uid = uids[i];
    try {
      // 翻页：next 用上一页返回的游标（没有就用最后一条的 liveId），直到翻够或没数据
      const raw = [];
      let next = newestLiveId;
      for (let pg = 0; pg < VOD_PAGES; pg++) {
        const r = await fetchLiveListPage({ userId: uid, next, record: true });
        const cur = r.list || [];
        if (!cur.length) break;
        for (const it of cur) {
          if (raw.some((x) => String(x.liveId) === String(it.liveId))) continue;
          raw.push(it);
        }
        const nx = String(r.next || '');
        const lastId = String(cur[cur.length - 1].liveId || '');
        if (!nx || nx === '0' || nx === String(next) || (!cur.length)) break;
        next = nx !== '0' ? nx : lastId;
        if (raw.length >= VOD_KEEP) break;
      }
      const list = raw.slice(0, VOD_KEEP);
      if (list.length) {
        const out = [];
        for (let k = 0; k < list.length; k++) {
          const it = list[k];
          let play = pickPlayable([it.playStreamPath, it.hlsStreamPath, it.streamPath]);
          if (!play && k < VOD_PLAY) {
            try {
              const one = await fetchLiveOne(it.liveId);
              play = pickPlayable([one.playStreamPath, one.hlsStreamPath, one.liveStreamPath, one.streamPath]);
            } catch (e) { /* 忽略 */ }
          }
          out.push({
            liveId: String(it.liveId),
            title: it.title || '',
            cover: it.coverPath || it.cover || '',
            ctime: Number(it.ctime) || 0,
            play,
          });
        }
        batch.push({ uid, list: out });
        has++;
      }
    } catch (e) {
      // 单个人失败不影响整体
    }
    done++;
    if (done % 50 === 0) log(`进度 ${done}/${uids.length} · 有录播 ${has} 人 · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    await flush(false);
  }
}

await Promise.all(Array.from({ length: Math.min(CONC, uids.length) }, worker));
await flush(true);
log(`完成：${uids.length} 人中 ${has} 人有录播 · 耗时 ${((Date.now() - t0) / 1000 / 60).toFixed(1)} 分钟`);
