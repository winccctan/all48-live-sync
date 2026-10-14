/**
 * 探测：录播列表里「更老的场次」到底能不能取到可播地址。
 *
 * 背景：回填时只给每人前 N 条（VOD_PLAY）调 getLiveOne 取地址，
 * 于是前端只有最近几场能点播。本脚本对**全部**场次逐条取地址，
 * 回答两个问题：
 *   1) 老回放（第 20 / 40 / 60 条）到底有没有 http 地址？有 ⇒ 可以做到全量点播。
 *   2) 逐条取一次要多久？500 人 × 60 条能不能在 Actions 时限内跑完？
 *
 * 用法（GitHub Actions 手动触发 workflow「录播回填」，填 inputs）：
 *   UIDS=18,1,100  只探测这几个人（默认 18）
 *   PROBE_PAGES=3  翻几页（默认 3 ⇒ 最多 60 条）
 * 环境变量：POCKET48_TOKEN / SCRAPE_PROXY
 */
import { fetchLiveListPage, fetchLiveOne, fetchNewestLiveId, pickPlayable } from './lib/api.mjs';

const UIDS = (process.env.UIDS || '18').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const PAGES = Number(process.env.PROBE_PAGES || 3);
const CONC = Number(process.env.PROBE_CONC || 4);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ymd = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '-');

log(`探测 ${UIDS.length} 人 · 每人翻 ${PAGES} 页 · 逐条取地址`);
const newestLiveId = await fetchNewestLiveId({ groupId: 1, record: true });
log('翻页起点 liveId=' + newestLiveId);

async function one(uid) {
  // ① 翻页拿全量列表
  const raw = [];
  let next = newestLiveId;
  for (let pg = 0; pg < PAGES; pg++) {
    const r = await fetchLiveListPage({ userId: uid, next, record: true });
    const cur = r.list || [];
    if (!cur.length) break;
    for (const it of cur) {
      if (raw.some((x) => String(x.liveId) === String(it.liveId))) continue;
      raw.push(it);
    }
    const nx = String(r.next || '');
    const lastId = String(cur[cur.length - 1].liveId || '');
    if (!nx || nx === '0' || nx === String(next)) break;
    next = nx !== '0' ? nx : lastId;
  }
  log(`uid ${uid}: 列表 ${raw.length} 条`);

  // ② 逐条取地址（并发，但别太猛，怕被限流）
  const t0 = Date.now();
  const rows = new Array(raw.length);
  let idx = 0;
  async function w() {
    for (;;) {
      const i = idx++;
      if (i >= raw.length) return;
      const it = raw[i];
      let play = pickPlayable([it.playStreamPath, it.hlsStreamPath, it.streamPath]);
      let src = play ? 'list' : '';
      let keys = null;
      let err = '';
      if (!play) {
        try {
          const one2 = await fetchLiveOne(it.liveId);
          play = pickPlayable([one2.playStreamPath, one2.hlsStreamPath, one2.liveStreamPath, one2.streamPath, one2.rtmpPath]);
          src = play ? 'getLiveOne' : 'empty';   // 接口通了但没给地址 ⇒ 上游无源
          keys = one2.streamKeys;
        } catch (e) { err = String((e && e.message) || e).slice(0, 100); src = 'error'; }
      }
      rows[i] = { i, liveId: String(it.liveId), ctime: Number(it.ctime) || 0, play, src, keys, err };
    }
  }
  await Promise.all(Array.from({ length: CONC }, w));

  const ok = rows.filter((r) => r && r.play);
  const empty = rows.filter((r) => r && r.src === 'empty');
  const errs = rows.filter((r) => r && r.src === 'error');
  log(`uid ${uid}: ${raw.length} 场中 ${ok.length} 场有 http 地址 · ` +
    `接口通但没源 ${empty.length} · 请求报错 ${errs.length} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (errs.length) {
    const byMsg = new Map();
    for (const r of errs) byMsg.set(r.err, (byMsg.get(r.err) || 0) + 1);
    log('  报错分布：' + [...byMsg.entries()].map(([m, n]) => `${n}× ${m.slice(0, 60)}`).join(' | '));
  }
  const e0 = empty[0];
  if (e0 && e0.keys) log(`  [没源样本 #${e0.i} ${ymd(e0.ctime)}] 原始流字段：${JSON.stringify(e0.keys)}`);

  // ③ 抽样：头尾 + 中段，看老场次的成色
  const picks = [0, 1, 2, 9, 14, 15, 19, 20, 29, 39, 44, 59].filter((i) => rows[i]);
  for (const i of picks) {
    const r = rows[i];
    log(`   #${r.i} ${ymd(r.ctime)} ${r.play ? '✅' : '❌'} [${r.src || '无'}] ${(r.play || '').slice(0, 70)}`);
  }
  // ④ 一条典型的原始流字段（排查还有没有别的可用字段）
  const sample = rows.find((r) => r && r.keys && !r.play) || rows.find((r) => r && r.keys);
  if (sample && sample.keys) log(`   [原始流字段样本 #${sample.i}] ${JSON.stringify(sample.keys)}`);
  return { uid, total: raw.length, ok: ok.length, sec: (Date.now() - t0) / 1000 };
}

const out = [];
for (const uid of UIDS) {
  try { out.push(await one(uid)); } catch (e) { log(`uid ${uid} 失败：${e.message}`); }
}
const tot = out.reduce((s, x) => s + x.total, 0);
const okk = out.reduce((s, x) => s + x.ok, 0);
log(`==== 汇总：${tot} 场中 ${okk} 场可播（${((okk / Math.max(tot, 1)) * 100).toFixed(0)}%）====`);
log(`按此速度，500 人全量取址约需 ${((out.reduce((s, x) => s + x.sec, 0) / Math.max(out.length, 1)) * 500 / 60).toFixed(0)} 分钟（并发 ${CONC}）`);
