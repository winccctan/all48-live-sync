/**
 * 2026 星梦剧院·年度之星 MVP 榜 —— 抓取与上报
 *
 * 数据源（口袋48 官方，MVP 活动页 mvp.ckg48.com 自己用的接口）：
 *   ① POST {API}/scan/api/scan/v2/get/condition  {"year":2026}
 *      → 18 支队伍 + 255 名成员（teamId/teamName/starInfos[memberId,memberName]）
 *   ② POST {API}/scan/api/scan/v1/query/mvp  {"year","teamId","userId"}
 *      → 单人 MVP 明细：totalScore / openLiveTicketScore / pocketVipScore / openLiveScore / tenYearEpScore
 *
 * 🔴 两个必踩的坑（2026-10-21 已踩过）：
 *   · 必须带浏览器头（UA + Referer: http://mvp.ckg48.com/2026/ + Origin: http://mvp.ckg48.com），
 *     用 App 那头（appInfo/pa）会被 WAF 打回。
 *   · ②只传 teamId 不传 userId 会 500，只能逐人查（255 次请求，并发 8 约 30 秒）。
 *
 * 环境变量：
 *   YEAR          默认 2026
 *   SITE_URL      上报目标（默认线上 workers.dev，绕开自定义域上的 bot 挑战）
 *   INGEST_TOKEN  与 /api/ingest 同一个 token
 *   DRY=1         只打印摘要，不上报
 */
import { postJson } from './lib/api.mjs';

const YEAR = Number(process.env.YEAR || 2026);
const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const INGEST = process.env.INGEST_TOKEN || '';
const DRY = process.env.DRY === '1' || process.env.DRY === 'true';
const CONCURRENCY = Math.max(1, Number(process.env.MVP_CONCURRENCY || 8));

const t0 = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// MVP 接口要「浏览器」身份，不是 App 身份
const MVP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'http://mvp.ckg48.com/2026/',
  Origin: 'http://mvp.ckg48.com',
};

/** 逐人明细。返回 null 表示这个人还没数据（接口 500/空 content）。 */
async function fetchOne(teamId, userId) {
  try {
    const j = await postJson('/scan/api/scan/v1/query/mvp', { year: YEAR, teamId: Number(teamId), userId: Number(userId) }, { headers: MVP_HEADERS, retries: 3 });
    const c = (j && j.content) || null;
    if (!c) return null;
    const n = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
    return {
      total: n(c.totalScore),
      ticket: n(c.openLiveTicketScore),
      vip: n(c.pocketVipScore),
      live: n(c.openLiveScore),
      star: n(c.tenYearEpScore),
      avatar: c.avatar || '',
    };
  } catch (e) {
    log(`  ! ${userId} 明细失败：${String((e && e.message) || e).slice(0, 90)}`);
    return null;
  }
}

/** 简单并发池 */
async function pool(items, n, worker) {
  const out = new Array(items.length);
  let i = 0;
  const run = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await worker(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

async function main() {
  log(`抓 MVP ${YEAR} 榜 · 目标 ${SITE} · 并发 ${CONCURRENCY}${DRY ? ' · DRY' : ''}`);

  const cond = await postJson('/scan/api/scan/v2/get/condition', { year: YEAR }, { headers: MVP_HEADERS, retries: 4 });
  const teams = ((cond && cond.content && cond.content.teamMemberData) || []).map((t) => ({
    teamId: String(t.teamId),
    teamName: t.teamName,
    members: (t.starInfos || []).map((m) => ({
      memberId: String(m.memberId),
      name: m.memberName || '',
      _abbr: m.memberAbbr || '',
    })),
  }));
  const total = teams.reduce((a, t) => a + t.members.length, 0);
  log(`队伍 ${teams.length} 队 · 成员 ${total} 人，开始拉明细…`);
  if (!teams.length) throw new Error('condition 返回 0 队，接口结构可能变了');

  // 逐人拉明细
  const jobs = [];
  teams.forEach((t) => t.members.forEach((m) => jobs.push({ t, m })));
  let done = 0;
  await pool(jobs, CONCURRENCY, async ({ t, m }) => {
    const one = await fetchOne(t.teamId, m.memberId);
    m.total = one ? one.total : 0;
    m.ticket = one ? one.ticket : 0;
    m.vip = one ? one.vip : 0;
    m.live = one ? one.live : 0;
    m.star = one ? one.star : 0;
    if (one && one.avatar) m.avatar = one.avatar;
    if (++done % 50 === 0) log(`  明细 ${done}/${total}`);
  });

  // 🔴 跨队重复（2026-10-25 发现）：官方 condition 里同一个 memberId 会出现在**两支队伍**，
  //    转队后旧队名单没清，且 query/mvp 按不同 teamId 返回**不同分数**。
  //    实测 255 条目只有 245 个不同成员，10 人重复，例：
  //      张琼予  GNZ48 TEAM G 9,782,051.5  /  SNH48 TEAM X 126,024.5
  //      朱怡欣  SNH48 TEAM NII 5,981,553  /  GNZ48 TEAM Z 421,209
  //    一个人只能占一个名次 ⇒ 取**分数最高**的那条当主身份（= 当前主力队伍），
  //    队伍榜也只在该队保留她，避免同一个人在两支队榜里各出现一次。
  const mainOf = new Map();
  teams.forEach((t) => t.members.forEach((m) => {
    const cur = mainOf.get(m.memberId);
    if (!cur || m.total > cur.total) mainOf.set(m.memberId, { teamId: t.teamId, total: m.total });
  }));
  let dropped = 0;
  teams.forEach((t) => {
    const before = t.members.length;
    t.members = t.members.filter((m) => {
      const isMain = mainOf.get(m.memberId).teamId === t.teamId;
      if (!isMain) dropped++;
      return isMain;
    });
    if (t.members.length !== before) log(`  · ${t.teamName} 去掉 ${before - t.members.length} 条跨队重复`);
  });
  if (dropped) log(`跨队重复：合并 ${dropped} 条，实际成员 ${mainOf.size} 人`);

  // 队内排名
  teams.forEach((t) => {
    t.members.sort((a, b) => b.total - a.total);
    t.members.forEach((m, idx) => { m.rank = idx + 1; });
  });

  // 全团榜
  const overall = [];
  teams.forEach((t) => t.members.forEach((m) => overall.push({
    teamName: t.teamName, memberId: m.memberId, name: m.name,
    total: m.total, ticket: m.ticket, vip: m.vip, live: m.live, star: m.star,
  })));
  overall.sort((a, b) => b.total - a.total);
  overall.forEach((m, idx) => { m.overallRank = idx + 1; });
  // 把全团名次回填到队内成员上
  const overallById = new Map(overall.map((m) => [m.memberId, m.overallRank]));
  teams.forEach((t) => t.members.forEach((m) => {
    m.overallRank = overallById.get(m.memberId) || overall.length;
    delete m._abbr;
  }));

  const withScore = overall.filter((m) => m.total > 0).length;
  log(`完成：全团 ${overall.length} 人，其中有分数 ${withScore} 人 · 榜首 ${overall[0] ? overall[0].name + ' ' + overall[0].total : '-'}`);

  const payload = {
    year: YEAR,
    at: Date.now(),
    generatedAt: new Date().toISOString(),
    teams,
    overall,
  };

  if (DRY) {
    log(`[DRY] 不上报，体积 ${(JSON.stringify(payload).length / 1024).toFixed(1)} KB`);
    console.log(JSON.stringify(payload.teams[0], null, 1).slice(0, 600));
    return;
  }

  const res = await fetch(SITE + '/api/mvp/put', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-token': INGEST,
      Accept: 'application/json',
      // 服务端只允许「北京周三 11:50–13:10」写入（站长 2026-10-28 铁律）。
      // 人工急救补一期时才用 MVP_FORCE=1 越过窗口。
      ...(process.env.MVP_FORCE === '1' ? { 'x-mvp-force': '1' } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90000),
  });
  const txt = await res.text();
  // 409 = 不在更新窗口（或同期重复被拦）；这不是抓取失败，但必须让人看见，不能静默成功
  if (res.status === 409) throw new Error(`被服务端拒绝（不在周三 12:01 窗口）：${txt.slice(0, 200)}`);
  if (!res.ok) throw new Error(`上报失败 HTTP ${res.status} ${txt.slice(0, 200)}`);
  log(`上报完成 ${txt} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 体积 ${(JSON.stringify(payload).length / 1024).toFixed(1)}KB`);
}

main().catch((e) => {
  console.error('MVP 抓取失败：', (e && e.stack) || e);
  process.exit(1);
});
