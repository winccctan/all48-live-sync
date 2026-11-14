// 口袋48「聚聚榜 / 乱斗榜」接口客户端
//
// 来源：yaya_msg v2.14 发布包 app.asar → src/common/pocket-runtime.mjs
//       （仓库源码里这段被作者剔掉了，但发布包必须带着才能跑，所以拆包能拿到）
// 实测于 2026-10-29，四条全部 200 正常返回。
//
//   POST /gift/api/v1/melee/rank/getMeleeRankPage        {rankid}          → 周榜索引 + 当前周成员榜
//   POST /gift/api/v1/melee/rank/getMeleeWeekRank        {rankId}          → 指定周「成员」鸡腿榜（固定 7 名）
//   POST /gift/api/v1/melee/rank/getPersonMeleeRankPage  {resId=memberId}  → 该成员「粉丝」贡献榜（固定 16 名，最近结算周）
//   POST /gift/api/v1/melee/rank/getMeleeYearRankPage    {}                → 恒 500「系统处理异常」，暂不可用
//
// 口径（拿我们自己的 lv 流水逐人对过，见 output/fp-archive-2025/melee-api.md）：
//   melee / totalCharm 单位 = 鸡腿，含 房间 + 直播 + 公演 + 公开翻牌，不含私密翻牌。
//
// 用法：
//   node melee-rank.mjs weeks                  # 列出全部周榜 id（427→17）
//   node melee-rank.mjs week 427               # 取某一周的成员榜（前 7）
//   node melee-rank.mjs person 530452          # 取某成员的粉丝榜（前 16）
//   node melee-rank.mjs backfill [起] [止]      # 批量抓周榜，落 output/melee-weeks.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN;
const R = '/gift/api/v1/melee/rank';
const P = {
  page:   `${R}/getMeleeRankPage`,
  week:   `${R}/getMeleeWeekRank`,
  person: `${R}/getPersonMeleeRankPage`,
  year:   `${R}/getMeleeYearRankPage`,
};

const call = (path, body) => postJson(path, body, { token: TOKEN, retries: 2 });
const EARLIEST_WEEK_ID = 17;   // yaya_msg 源码里的下限

async function weeks() {
  const r = await call(P.page, { rankid: 0 });
  const known = r.content?.weekRankList || [];
  const latest = known.reduce((a, b) => (Number(b.weekRankId) > Number(a.weekRankId || 0) ? b : a), {});
  const latestId = Number(latest.weekRankId) || 0;
  const byId = new Map(known.map((w) => [Number(w.weekRankId), w.weekRankName]));
  const out = [];
  for (let id = latestId; id >= EARLIEST_WEEK_ID; id--) {
    out.push({ weekRankId: id, weekRankName: byId.get(id) || null });
  }
  return out;
}

async function week(rankId) {
  const r = await call(P.week, { rankId: Number(rankId) });
  return (r.content?.rankUserList || []).map((x) => ({
    rank: x.rankNum,
    melee: x.melee,
    memberId: x.baseUserInfo?.userId,
    nickname: x.baseUserInfo?.nickname,
    starName: x.baseUserInfo?.starName || '',
    isStar: !!x.baseUserInfo?.isStar,
    topFan: x.topUserInfo?.nickname || '',
    privacy: x.privacy,
  }));
}

async function person(memberId) {
  const r = await call(P.person, { resId: Number(memberId) });
  return (r.content?.charmInfo || []).map((x) => ({
    rank: x.rankNum,
    charm: x.totalCharm,
    userId: x.privacy ? null : x.userInfo?.userId,   // 隐私用户官方也返回 id，但我们不落
    nickname: x.privacy ? '匿名用户' : x.userInfo?.nickname,
    privacy: x.privacy,
  }));
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'weeks') {
  const w = await weeks();
  console.log(`共 ${w.length} 期，最新 ${w[0].weekRankId}（${w[0].weekRankName}），最早 ${w.at(-1).weekRankId}`);
  for (const x of w.slice(0, 20)) console.log(`  ${x.weekRankId}  ${x.weekRankName || '(名称由客户端按周推算)'}`);
} else if (cmd === 'week') {
  for (const x of await week(a)) console.log(`#${x.rank}  ${x.melee.toLocaleString().padStart(12)}  ${x.nickname}  榜首粉丝=${x.topFan}`);
} else if (cmd === 'person') {
  for (const x of await person(a)) console.log(`#${x.rank}  ${x.charm.toLocaleString().padStart(12)}  ${x.nickname}${x.privacy ? ' (隐私)' : ''}`);
} else if (cmd === 'backfill') {
  const from = Number(a) || EARLIEST_WEEK_ID;
  const to = Number(b) || 0;
  const list = (await weeks()).filter((w) => w.weekRankId >= from && w.weekRankId <= (to || 1e9));
  const out = {};
  for (const w of list) {
    try {
      out[w.weekRankId] = { name: w.weekRankName, rows: await week(w.weekRankId) };
      const top = out[w.weekRankId].rows[0];
      console.log(`${w.weekRankId} ✓ ${top ? top.melee.toLocaleString() + ' ' + top.nickname : '(空)'}`);
    } catch (e) {
      out[w.weekRankId] = { error: String(e.message).slice(0, 80) };
      console.log(`${w.weekRankId} ✗ ${e.message.slice(0, 60)}`);
    }
    await new Promise((r) => setTimeout(r, 120));   // 别把接口打爆
  }
  mkdirSync('output', { recursive: true });
  writeFileSync('output/melee-weeks.json', JSON.stringify(out, null, 1));
  console.log(`\n已写 output/melee-weeks.json（${Object.keys(out).length} 期）`);
} else {
  console.log('用法: node melee-rank.mjs weeks | week <id> | person <memberId> | backfill [起] [止]');
}
