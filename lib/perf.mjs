/**
 * 公演直播统计：把「一条礼物记录」归到「哪一场公演 / 哪个队伍」。
 *
 * 为什么需要这层：
 *   公演直播间的聊天室是**一个团一个**（SNH48=3869841 / BEJ48=3872562 / GNZ48=3874066 /
 *   CKG48=18287134 / CGT48=6681982），不是一场一个。同团所有公演共用同一个房间，
 *   所以礼物本身不带场次信息，只能靠「记录时间落在哪场的 stime~endTime 里」来归场。
 *
 * 归属优先级：
 *   1) 时间窗内的场次（多场重叠时取开始时间最晚的那场，即"正在进行"的那场）
 *   2) 找不到 → 记到「场外」（演出前后的闲聊送礼，不计入任何队伍）
 */

const BJ = 8 * 3600e3;

/** 场次该算哪个队伍：teamList 为空时归「联合/其他」 */
export function teamOf(p) {
  const t = Array.isArray(p.teams) ? p.teams.filter(Boolean) : [];
  if (!t.length) return '联合/其他';
  return t.join('+');
}

/** 时间窗判定：优先选开始时间最晚（最靠近当前）的那场 */
export function perfAt(perfs, t, groupName) {
  let best = null;
  for (const p of perfs) {
    if (groupName && p.g !== groupName) continue;
    if (!p.st) continue;
    const end = p.et && p.et > p.st ? p.et : p.st + 4 * 3600e3; // 缺 endTime 时按 4 小时兜底
    if (t >= p.st && t <= end) {
      if (!best || p.st > best.st) best = p;
    }
  }
  return best;
}

/**
 * @param {Array} perfs   perf-sync 产出的场次数组
 * @param {Array} gifts   礼物记录 [{t, g(团名), gname, num, val, sid, sn}]
 * @returns {{ rows: Array, outside: object, perPerf: Map }}
 */
export function aggregateByTeam(perfs, gifts) {
  const map = new Map(); // `${团}|${队}` → row
  const perPerf = new Map(); // perfId → { val, num, cnt }
  const outside = { val: 0, num: 0, cnt: 0 };

  const touch = (row) => {
    if (!map.has(row.key)) map.set(row.key, row);
    return map.get(row.key);
  };

  for (const g of gifts) {
    const p = perfAt(perfs, g.t, g.g);
    const val = Number(g.val) || 0;
    const num = Number(g.num) || 0;
    if (!p) {
      outside.val += val; outside.num += num; outside.cnt++;
      continue;
    }
    const team = teamOf(p);
    const row = touch({
      key: p.g + '|' + team, group: p.g, team,
      val: 0, num: 0, cnt: 0, senders: new Set(), perfIds: new Set(),
    });
    row.val += val; row.num += num; row.cnt++;
    row.senders.add(g.sid);
    row.perfIds.add(p.id);

    const pp = perPerf.get(p.id) || { val: 0, num: 0, cnt: 0, senders: new Set() };
    pp.val += val; pp.num += num; pp.cnt++; pp.senders.add(g.sid);
    perPerf.set(p.id, pp);
  }

  // 补上「没收到任何礼物」的场次队伍，保证榜上能看到 0
  for (const p of perfs) {
    const team = teamOf(p);
    touch({
      key: p.g + '|' + team, group: p.g, team,
      val: 0, num: 0, cnt: 0, senders: new Set(), perfIds: new Set(),
    });
  }

  const rows = [...map.values()]
    .map((r) => ({
      group: r.group, team: r.team,
      val: r.val, num: r.num, cnt: r.cnt,
      senders: r.senders.size,
      perfs: r.perfIds.size,
      avg: r.perfIds.size ? Math.round(r.val / r.perfIds.size) : 0,
    }))
    .sort((a, b) => b.val - a.val);

  return { rows, outside, perPerf };
}

/** 场次排期时长（分钟）：官方 stime→endTime 含前后缓冲，不等于真实演出时长 */
export function slotMinutes(p) {
  if (!p.st || !p.et) return 0;
  return Math.round((p.et - p.st) / 60000);
}

export { BJ };
