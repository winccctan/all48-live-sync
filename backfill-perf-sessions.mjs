#!/usr/bin/env node
/**
 * backfill-perf-sessions.mjs —— 补齐公演**场次记录**（不含礼物）
 *
 * 为什么需要：
 *   公演礼物只能靠 perf-gift-sync 在开演时盯 48fan 弹幕流采，错过就没有（无回放、
 *   官方 /Index/ajax_getmemberhot 的 token 只在场次进行中有效，实测场次结束后
 *   页面还在但 #vedio_id / #param 全部消失）。
 *   但**场次本身**能从口袋48 归档排期（getOpenLiveList record:true）拉到 ⇒ 可以补。
 *
 * 补了有什么用：
 *   · lv /perf 页面能显示「那天确实办过公演」，而不是静默消失；
 *   · worker 的 tickPerf 靠 perf:sessions 判「有没有场次在演」，排期不断档才能正常拨号。
 *
 * 🔴 只补「库里没有的」场次，绝不覆盖已有记录（已有记录可能带 et/status 等更准的信息）。
 * 🔴 只补指定日期区间，避免把口袋48 归档里未来两个月的场次一次性灌进去
 *    （R2 里 perf:sessions 按 st 倒序截 400 条，灌太多会把十月的老场次挤掉）。
 *
 * 用法：
 *   FROM=20261024 TO=20261101 node backfill-perf-sessions.mjs      # 只打印
 *   FROM=20261024 TO=20261101 WRITE=1 node backfill-perf-sessions.mjs
 */
import { postJson } from './lib/api.mjs';

const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const WRITE = !!process.env.WRITE;
const BJ = 8 * 3600e3;

const FROM = String(process.env.FROM || '');
const TO = String(process.env.TO || '');
if (!/^\d{8}$/.test(FROM) || !/^\d{8}$/.test(TO)) {
  console.error('必须给 FROM=YYYYMMDD TO=YYYYMMDD');
  process.exit(1);
}
const fromMs = Date.parse(`${FROM.slice(0, 4)}-${FROM.slice(4, 6)}-${FROM.slice(6, 8)}T00:00:00+08:00`);
const toMs = Date.parse(`${TO.slice(0, 4)}-${TO.slice(4, 6)}-${TO.slice(6, 8)}T23:59:59+08:00`);

const GROUPS = [
  { id: 10, name: 'SNH48' }, { id: 11, name: 'BEJ48' }, { id: 12, name: 'GNZ48' },
  { id: 14, name: 'CKG48' }, { id: 21, name: 'CGT48' },
];

const bj = (t) => new Date(Number(t) + BJ).toISOString().replace('T', ' ').slice(5, 16);

async function fetchArchive(g) {
  const out = [];
  let next = 0, pages = 0;
  for (;;) {
    const j = await postJson('/live/api/v1/live/getOpenLiveList',
      { debug: false, groupId: g.id, next, record: true }, { retries: 3 });
    const c = j?.content || {};
    const list = Array.isArray(c.liveList) ? c.liveList : [];
    if (!list.length) break;
    pages++;
    for (const it of list) {
      const st = Number(it.stime) || 0;
      if (!st || st < fromMs || st > toMs) continue;
      const id = String(it.liveId || '');
      if (!id) continue;
      out.push({
        id, g: g.name,
        team: (it.teamList || []).map((t) => t.teamName).filter(Boolean).join(' / '),
        title: String(it.title || '').slice(0, 80),
        sub: String(it.subTitle || '').slice(0, 60),
        st, et: Number(it.endTime) || 0,
        status: Number(it.status) || 0,
        praise: 0,
      });
    }
    next = c.next ?? 0;
    if (!next || pages >= 20) break;
  }
  return out;
}

async function existing() {
  const r = await fetch(`${SITE}/api/perf/sessions`, {
    headers: { 'x-ingest-token': INGEST, 'x-lv-token': INGEST, accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`读场次失败 HTTP ${r.status}`);
  const j = await r.json();
  return new Set((j.list || []).map((x) => String(x.id)));
}

(async () => {
  const have = await existing();
  console.log(`库里已有 ${have.size} 场；目标区间 ${FROM}–${TO}`);
  const all = [];
  for (const g of GROUPS) {
    try {
      const list = await fetchArchive(g);
      console.log(`  ${g.name.padEnd(6)} 归档区间内 ${list.length} 场`);
      all.push(...list);
    } catch (e) {
      console.log(`  ${g.name.padEnd(6)} 拉取失败：${String(e.message).slice(0, 70)}`);
    }
  }
  const miss = all.filter((s) => !have.has(s.id)).sort((a, b) => a.st - b.st);
  console.log(`\n缺 ${miss.length} 场：`);
  for (const s of miss) console.log(`  ${bj(s.st)}  ${s.g}/${s.team || '-'}  ${s.title}`);

  if (!miss.length) return console.log('\n无需补齐。');
  if (!WRITE) return console.log('\n（DRY：加 WRITE=1 才写）');

  const r = await fetch(`${SITE}/api/perf/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ingest-token': INGEST, 'user-agent': 'all48-perf-sessions/1.0' },
    body: JSON.stringify({ sessions: miss }),
    signal: AbortSignal.timeout(30000),
  });
  console.log('\n写入结果', r.status, await r.text());
})();
