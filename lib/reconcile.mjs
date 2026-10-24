/**
 * 礼物记录对账（纯函数，不碰网络）
 * =====================================================================
 * 红蓝歌会的直播侧礼物有多个来源，同一份礼物会被重复拿到：
 *   ① live-sse-sync.mjs       —— 48fan SSE，时间戳用 serverTime（毫秒）
 *   ② backfill-live-gift.mjs  —— 回放 .lrc，时间戳用 ctime + 弹幕偏移
 *   ③ xox-live-backfill.mjs   —— xox48.top，时间戳用它自己的入库时间
 *
 * 三路的时间起点各不相同，同一条礼物算出来的 t 能差几十秒到几分钟；
 * 而 worker 的去重键是「精确 t|sid|mid|gid|num|src」，对不上 ⇒ **双倍计分**。
 *
 * 所以每路在写入前都要先跟「站里已有的」对一遍：
 * 能一对一配上的就当已有，只把配不上的补进去。
 *
 * 🔴 匹配规则：同送礼人昵称 + 同份数 + |Δt| <= TOL。
 *   为什么不用精确时间：见上，三个时间源本来就不可能对齐。
 *   为什么误判率够低：同一个人在同一场直播里送同样数量的礼物重复出现本来就少，
 *   再加时间窗口约束后基本可忽略。原则是**宁可少补一条，绝不重复计分**。
 */

/** 昵称归一：去空白、转小写（跨来源的昵称可能差空格/大小写） */
export function normNick(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/**
 * 一对一匹配两批记录。
 *
 * 🔴 配对必须**按时间差从小到大全局贪心**，不能按 theirs 的时间顺序逐个找最近：
 *    2026-10-25 康楚翊的 E-1u 在 20:36~20:37 连送 6 次 1 分（间隔 6~15 秒），
 *    站里只有 5 条（其中两条都落在 20:37:19）。按顺序找最近会「先到先占」，
 *    把 xox 的某一条配给了本该属于另一条的站内记录 ⇒ 剩下那条判成「我们有」，
 *    缺口永远补不上。全局最小差排序后配对，错配概率最低。
 *
 * @param {{t:number,sn:string,num:number}[]} mine    站里已有的
 * @param {{t:number,sn:string,num:number}[]} theirs  这次准备写入的
 * @param {number} tolMs  时间容差（毫秒）
 * @returns {{t:number,sn:string,num:number}[]}  theirs 里配不上 mine 的那些（= 真正要补的）
 */
export function reconcileRows(mine, theirs, tolMs = 20 * 60000) {
  const used = new Array(mine.length).fill(false);
  const taken = new Array(theirs.length).fill(false);

  // 先按「昵称 + 份数」分桶，只桶内两两比时间，191 人 × 几十条也不慢
  const bucket = new Map();
  for (let k = 0; k < mine.length; k++) {
    const o = mine[k];
    const key = normNick(o.sn) + '|' + (Number(o.num) || 0);
    const a = bucket.get(key);
    if (a) a.push(k); else bucket.set(key, [k]);
  }
  const pairs = [];
  for (let i = 0; i < theirs.length; i++) {
    const x = theirs[i];
    const cand = bucket.get(normNick(x.sn) + '|' + (Number(x.num) || 0));
    if (!cand) continue;
    for (const k of cand) {
      const d = Math.abs(mine[k].t - x.t);
      if (d <= tolMs) pairs.push([d, i, k]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  for (const [, i, k] of pairs) {
    if (taken[i] || used[k]) continue;
    taken[i] = true;
    used[k] = true;
  }
  return theirs.filter((_, i) => !taken[i]);
}

/**
 * 把「站里已有的直播记录」按成员分组，便于按 mid 取用。
 * @param {[number,number,string,number][]} rows  [[t, mid, sn, num]]（worker /api/gift/liveall 的输出）
 */
export function indexByMid(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!Array.isArray(r)) continue;
    const t = Number(r[0]) || 0;
    const mid = Number(r[1]) || 0;
    if (!t || !mid) continue;
    const item = { t, sn: String(r[2] || '').slice(0, 40), num: Math.max(1, Number(r[3]) || 1) };
    const a = m.get(mid);
    if (a) a.push(item);
    else m.set(mid, [item]);
  }
  return m;
}
