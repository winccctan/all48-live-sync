#!/usr/bin/env node
/**
 * probe-perf-rank.mjs —— 找「口袋48 官方公演鸡腿榜」的接口
 *
 * 为什么必须找到它（2026-10-25 站长：「不允许丢数据，必须给方案」）：
 *   公演礼物只能靠 48fan 弹幕流实时抓，流一断就永久少分（没有回放、IM 也对公演聊天室报「目标不存在」）。
 *   站长 App 里能看到的「公演鸡腿」「公演鸡腿贡献明细（单日）」「公演场次成员榜」必然有接口，
 *   只要找到它 ⇒ 每 20~30 秒轮询官方权威值 ⇒ 差额自动补账 ⇒ 榜面数字永远等于官方。
 *
 * 用法（需 POCKET48_TOKEN + 国内出口 SCRAPE_PROXY）：
 *   POCKET48_TOKEN=xxx SCRAPE_PROXY=... node probe-perf-rank.mjs [liveId ...]
 *   不带 liveId 就自动取「正在直播的公演」。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
const BJ = 8 * 3600e3;
const log = (...a) => console.log(new Date(Date.now() + BJ).toISOString().slice(11, 19), ...a);

/* ---------- 1) 找到今天在播/刚结束的公演，作为探测样本 ---------- */
async function liveIds() {
  const ids = [];
  try {
    const d = await postJson('/live/api/v1/live/getOpenLiveList', { debug: false, next: 0, record: true }, { token: TOKEN, retries: 2 });
    for (const it of (d?.content?.liveList || []).slice(0, 6)) {
      if (it.liveId) ids.push(String(it.liveId));
    }
  } catch (e) { log('取公演列表失败：' + String(e.message).slice(0, 80)); }
  return ids;
}

const args = process.argv.slice(2);
const ids = args.length ? args : await liveIds();
if (!ids.length) { console.error('没有可探测的 liveId，请手动传一个'); process.exit(1); }
const liveId = ids[0];
log(`样本 liveId=${liveId}（共 ${ids.length} 个候选）`);

/* ---------- 2) 候选接口：路径 + 参数组合 ---------- */
const CAND = [];
const add = (path, body, note) => CAND.push({ path, body, note });

for (const t of ['1', '2', '3', '4']) {
  add('/live/api/v1/live/getLiveRank', { liveId, type: t, page: 1, limit: 100 }, `getLiveRank type=${t}`);
  add('/live/api/v1/live/getOpenLiveRank', { liveId, type: t, page: 1, limit: 100 }, `getOpenLiveRank type=${t}`);
}
for (const p of [
  '/live/api/v1/performance/getPerfRank',
  '/live/api/v1/performance/getPerformanceRank',
  '/live/api/v1/performance/getGiftRank',
  '/live/api/v1/performance/getPerfGiftRank',
  '/live/api/v1/performance/getPerfGift',
  '/live/api/v1/performance/getPerfGiftDetail',
  '/live/api/v1/live/getPerfRank',
  '/live/api/v1/live/getPerformanceRank',
  '/live/api/v1/live/getLiveGiftRank',
  '/live/api/v1/live/getLiveGiftList',
  '/live/api/v1/gift/getLiveGiftRank',
  '/live/api/v1/gift/getPerfGiftRank',
  '/live/api/v1/rank/getPerfRank',
  '/live/api/v1/rank/getLiveGiftRank',
  '/live/api/v2/live/getLiveRank',
  '/live/api/v2/performance/getPerfRank',
]) {
  add(p, { liveId, type: '2', page: 1, limit: 100 }, p.split('/').slice(-2).join('/'));
}

/* ---------- 3) 逐个打，只报「像样的」结果 ---------- */
const shape = (o) => {
  if (!o || typeof o !== 'object') return String(o).slice(0, 60);
  if (Array.isArray(o)) return `array(${o.length}) ${o[0] ? JSON.stringify(o[0]).slice(0, 160) : ''}`;
  const k = Object.keys(o);
  return `{${k.slice(0, 8).join(',')}}`;
};

let hit = 0;
for (const c of CAND) {
  try {
    const d = await postJson(c.path, c.body, { token: TOKEN, retries: 0 });
    const content = d?.content;
    const empty = content == null
      || (Array.isArray(content) && content.length === 0)
      || (typeof content === 'object' && Object.keys(content).length === 0)
      || (content && Array.isArray(content.rankList) && content.rankList.length === 0)
      || (content && Array.isArray(content.list) && content.list.length === 0);
    const status = d?.status ?? d?.success;
    if (empty && (status === 200 || status === true)) {
      log(`· 空  ${c.note}  status=${status}`);
      continue;
    }
    hit++;
    log(`★ 有货 ${c.note}  status=${status}`);
    log(`   content: ${shape(content)}`);
    const s = JSON.stringify(d).slice(0, 900);
    log(`   raw: ${s}`);
  } catch (e) {
    const m = String(e.message || e);
    if (!/请求失败 (404|400)/.test(m)) log(`· 错  ${c.note}  ${m.slice(0, 100)}`);
  }
}
log(`探测完，有货 ${hit} 个`);
