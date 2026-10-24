/**
 * 拉「官方公演直播」排期 + 归档 → 本地 JSON（不写站点、不碰线上）
 *   node perf-sync.mjs [输出json]
 *
 * 数据源：POST /live/api/v1/live/getOpenLiveList（record=false 拿预告/在播，record=true 拿含录播）
 *         POST /live/api/v1/live/getOpenLiveOne（拿 roomId / 点赞 / 回放地址）
 *
 * 已实测（2026-10-24）：
 *   groupId 10=SNH48 11=BEJ48 12=GNZ48 14=CKG48 21=CGT48（13 是废弃的 SHY48 老档）
 *   status 1=未开播 2=直播中 4=已结束
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { postJson } from './lib/api.mjs';

export const GROUPS = [
  { id: 10, name: 'SNH48' },
  { id: 11, name: 'BEJ48' },
  { id: 12, name: 'GNZ48' },
  { id: 14, name: 'CKG48' },
  { id: 21, name: 'CGT48' },
];

const OUT = process.argv[2] || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/output/perf-20261024.json';
const DAYS_BACK = Number(process.env.DAYS_BACK || 45);
const SINCE = Date.now() - DAYS_BACK * 86400e3;

async function page(groupId, next, record) {
  const j = await postJson('/live/api/v1/live/getOpenLiveList', {
    debug: false, groupId, next: Number(next) || 0, record: !!record,
  });
  const c = j?.content || {};
  return { list: Array.isArray(c.liveList) ? c.liveList : [], next: c.next ?? 0 };
}

function pick(it, g) {
  const teams = (it.teamList || []).map((t) => t.teamName).filter(Boolean);
  return {
    id: String(it.liveId),
    g: g.name,
    gid: g.id,
    st: Number(it.stime) || 0,
    et: Number(it.endTime) || 0,
    title: it.title || '',
    sub: it.subTitle || '',
    status: Number(it.status) || 0,
    teams,
    play: Number(it.playNum) || 0,
    cover: it.coverPath || '',
  };
}

const perf = [];
const seen = new Set();
for (const g of GROUPS) {
  // 1) 预告 / 在播
  try {
    const { list } = await page(g.id, 0, false);
    for (const it of list) {
      const k = String(it.liveId);
      if (seen.has(k)) continue;
      seen.add(k);
      perf.push(pick(it, g));
    }
  } catch (e) { console.warn(`[${g.name}] 预告拉取失败`, String(e.message).slice(0, 80)); }

  // 2) 归档翻页（直到越过 SINCE）
  let next = 0;
  for (let i = 0; i < 40; i++) {
    let r;
    try { r = await page(g.id, next, true); } catch (e) { console.warn(`[${g.name}] 归档第${i + 1}页失败`, String(e.message).slice(0, 60)); break; }
    if (!r.list.length) break;
    for (const it of r.list) {
      const k = String(it.liveId);
      if (seen.has(k)) continue;
      seen.add(k);
      perf.push(pick(it, g));
    }
    const last = r.list[r.list.length - 1];
    if (!Number(r.next) || Number(last.stime) < SINCE) break;
    next = r.next;
  }
  process.stdout.write('.');
}
console.log('');

perf.sort((a, b) => b.st - a.st);

/* 补详情：点赞数 / 播放量 / 聊天室 roomId（逐场一次，并发 4） */
if (process.env.WITH_DETAIL !== '0') {
  const targets = perf.filter((p) => p.st <= Date.now() && p.st > Date.now() - 60 * 86400e3);
  let i = 0;
  async function worker() {
    while (i < targets.length) {
      const p = targets[i++];
      try {
        const d = await postJson('/live/api/v1/live/getOpenLiveOne', { liveId: p.id }, { retries: 3 });
        const c = d?.content || {};
        p.praise = Number(c.praiseNum) || 0;
        p.play = Number(c.playNum) || 0;
        p.room = Number(c.roomId) || 0;
      } catch { /* 单场失败不影响整体 */ }
    }
  }
  await Promise.all([0, 1, 2, 3].map(worker));
  console.log(`详情补齐 ${targets.length} 场`);
}

const payload = {
  at: Date.now(),
  daysBack: DAYS_BACK,
  groups: GROUPS,
  total: perf.length,
  perf,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload));
console.log(`✅ ${OUT}  共 ${perf.length} 场`);
const bj = (t) => (t ? new Date(t + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) : '-');
for (const p of perf.slice(0, 5)) console.log(`   ${bj(p.st)} ${p.g} ${p.teams.join('/') || '—'} ${p.title.slice(0, 22)}`);
