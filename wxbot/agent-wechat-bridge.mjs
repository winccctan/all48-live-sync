/**
 * 微信群指令桥 · agent-wechat（2026-11-12）
 * =====================================================
 * 站长：「可以不用 @ 消息，直接用 lg? 这样的指令吗」→ 默认不要求 @。
 *
 * 数据流：
 *   微信群消息 → wx messages watch（JSONL 事件流）→ 本脚本
 *     → 认 `lg?名字` / `鸡腿?名字`（不要求 @）→ GET /api/cmd（口径全在 all48-lv）
 *     → wx messages send <chatId> --text <回复>
 *
 * 与 QQ 那条（qqbot/bot.mjs）共用同一个 /api/cmd，改文案不用动这两个脚本。
 *
 * 🔴 三条硬规矩：
 *   1) 只用**小号**。这个号会以「你本人」的身份在群里说话。
 *   2) 只认 `lg` / `鸡腿` 前缀的指令，其余聊天一个字都不回（群里刷屏最招人烦）。
 *   3) 每条消息只回一次（messageId 去重），同群 1.5 秒内不连发第二条。
 *
 * 运行：
 *   set -a && source wxbot/agent-wechat.env && set +a
 *   node wxbot/agent-wechat-bridge.mjs            # 正式
 *   node wxbot/agent-wechat-bridge.mjs --dry      # 只看识别、不真发
 *   node wxbot/agent-wechat-bridge.mjs --ping     # 自检：拉一次 /api/cmd 验证 token
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const WX = String(process.env.WX_BIN || `${process.env.HOME}/.workbuddy/binaries/agent-wechat/bin/wx`);
const ACCOUNT = String(process.env.WX_ACCOUNT || 'test48');
const XDG = String(process.env.XDG_CONFIG_HOME || '/tmp/awcfg');   // 🔴 必须在可写区，否则原子重命名被沙箱拒
const WORKER = (process.env.WORKER_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const KEY = String(process.env.WX_QUEUE_TOKEN || '');
/** 允许的群：chatroom id（如 53524154991@chatroom），逗号分隔；留空 = 所有群 */
let GROUPS = String(process.env.WX_GROUPS || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
/** 是否必须 @ 本号才响应。默认 0 = 不需要 @（站长 2026-11-12 要求） */
let REQUIRE_MENTION = String(process.env.WX_REQUIRE_MENTION || '0') === '1';
const CURSOR = String(process.env.WX_CURSOR_FILE || `${XDG}/wxbot-cursor`);
/* 🔴 启动锚点。2026-11-12 23:00 线上事故：`START_AT` / `SILENT_UNTIL` 只在 handle() 里被引用，
   从来没有定义过 ⇒ 每条消息进来第一件事就 ReferenceError，整条被静默丢掉，
   表现就是「机器人在线、但一个字都不回」（比报错更难查）。
   · START_AT：启动时刻，用来丢掉「启动前 2 分钟以外」的历史消息；
   · SILENT_UNTIL：**没有游标文件**（新机器 / 游标丢了）时前 3 分钟只记录不回复，
     否则 wx 会把整批历史消息重放一遍，机器人逐条回 = 群里刷屏。 */
const START_AT = Date.now();
const SILENT_UNTIL = existsSync(CURSOR) ? 0 : Date.now() + 3 * 60 * 1000;
let COOLDOWN = Math.max(500, Number(process.env.WX_COOLDOWN || 1500));
const DRY = process.argv.includes('--dry');
const PING = process.argv.includes('--ping');

/* ── AI 聊天（2026-11-12 站长：「可以 @ 机器人可以和它聊天吗 给它ai的功能」）──────
   设计取舍：
   1) **只认 @ 本号** 或 `ai?问题` 前缀 —— 群里闲聊天一个字都不接，否则既烧钱又刷屏；
   2) 上下文只留最近 8 条（每个群一份），不做长期记忆；
   3) 每群每天封顶 AI_DAILY 次，防止有人刷；
   4) 顺手把当前榜单前 12 名/前 8 队塞进 system，让它能答「现在谁第一」这类问题；
   5) 指令（lg/rb）**优先于** AI：同一条消息先当指令解析，解析不了才交给模型。 */
/* 走哪条 AI：默认**走 worker 的 Workers AI**（账号自带免费额度、零 key、零成本）；
   只有在 env 里显式给了 AI_KEY 才走后付费的外部厂商（DeepSeek 等）。
   🔴 WorkBuddy 内置的免密钥模型用不了这条链路：它绑定「发布成应用的网页」、靠浏览器 Origin 鉴权，
      并明确禁止服务端代调 —— 我们是常驻 Node 进程，不是浏览器。 */
const AI_KEY = String(process.env.AI_KEY || '');
const AI_BASE = String(process.env.AI_BASE || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const AI_MODEL = String(process.env.AI_MODEL || 'deepseek-chat');
const AI_VIA_WORKER = !AI_KEY;          // 没有外部 key 就走 worker
const AI_ON = !!AI_KEY || !!KEY;
let AI_DAILY = Math.max(1, Number(process.env.AI_DAILY || 120));
const AI_CTX_TTL = 5 * 60 * 1000;

/* ── 王语晨动态推送（2026-11-12）────────────────────────────────────
   站长：「王语晨如果发言和上下线麻烦推到 游戏群，其他群不推」+「bot小群2 也推」。
   数据不是这里抓的：Actions（wxpush.yml，每 5 分钟一轮、轮内 20 秒补扫）盯着口袋48，
   把「开播/下播/房间消息/翻牌/上线/静默」写进 worker 的云端队列 K_WXB；
   本脚本每 6 秒取一次件（取件即清空 → 手机和 QQ 都不会抢），取到就发进 WX_PUSH_GROUPS。
   🔴 推送目标（WX_PUSH_GROUPS）和指令白名单（WX_GROUPS）是两件事：
      「重生之要当富豪榜前」只让它查询、不让它播报；「bot小群」同理 —— 站长明确「其他群不推」。
   🔴 为什么不在本机直接怼口袋48：Actions 那条已经把游标、开播防抖（连续 3 次不在列表才算下播）、
      冷启动保护（播了 >30 分钟不诈「开播」）都做好了，本机再写一套必然两边打架。 */
let PUSH_GROUPS = String(process.env.WX_PUSH_GROUPS || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
/** 群 → 该群要收**谁**的动态（2026-11-12 站长：「bot小群对接黄宣绮」「游戏群、bot小群2 收王语晨」）。
 *  env 写法：`WX_PUSH_MAP=53524154991@chatroom=王语晨,54162053602@chatroom=王语晨,57498523864@chatroom=黄宣绮`
 *  一个群收多人用 `|`：`…=王语晨|黄宣绮`。
 *  🔴 配了 MAP 就只看 MAP（比 WX_PUSH_GROUPS 优先）；没配才退回老行为（这些群收所有人）。 */
let PUSH_MAP = (() => {
  const m = new Map();
  const raw = String(process.env.WX_PUSH_MAP || '').trim();
  for (const part of raw.split(/[,\s]+/).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const g = part.slice(0, i).trim();
    const who = part.slice(i + 1).trim();
    if (g) m.set(g, who ? who.split('|').map((s) => s.trim()).filter(Boolean) : []);
  }
  return m;
})();
let PUSH_EVERY = Math.max(3000, Number(process.env.WX_PUSH_EVERY || 6000));
const PUSH_SEEN_FILE = String(process.env.WX_PUSH_SEEN || `${XDG}/state/wxpush-seen.json`);
const PUSH_SEEN_MAX = 400;              // 只留最近 400 个 id（够兜住几天的重复）
/** 首次启动只补最近 15 分钟 —— 队列里可能压着几小时前的历史，倒进群等于刷屏 */
const PUSH_BOOT_FRESH = 15 * 60e3;

/** 日志同时落盘：`run.sh > /tmp/wxbridge.log` 每次重启都会清掉，
 *  排查「某个群没收到推送」时就什么都查不到了（2026-11-12 踩过）。 */
const LOG_FILE = String(process.env.WX_LOG_FILE || `${XDG}/state/wxbridge.log`);
const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + ' ' + a.map((x) => String(x)).join(' ');
  console.log(line);
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, line + '\n'); } catch { }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 消息时间 → 毫秒时间戳。
 *  🔴 这个函数之前**只被调用、从未定义**（我在「历史消息不重放」那次改动里凭记忆写了一行
 *     `msgTimeMs(m)`）。结果每条群消息都在这里 ReferenceError 被 catch 吞掉：
 *     指令全哑、推送照常（推送走 pump，不经过 handle）。2026-11-13 修。
 *  agent-wechat 不同版本给的字段/单位都不同：createTime 可能是**秒**、可能是**毫秒**、也可能是字符串。
 *  换算错会让所有消息被判成「历史」而静默丢弃，所以这里必须按数量级判断，不能瞎乘。 */
function msgTimeMs(m) {
  if (!m || typeof m !== 'object') return 0;
  const raw = m.createTime ?? m.create_time ?? m.committedAt ?? m.timestamp ?? m.time ?? 0;
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'string' && !/^\d+$/.test(raw.trim())) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  }
  const n = Number(raw) || 0;
  if (n <= 0) return 0;
  if (n >= 1e11) return n;        // 毫秒（2001 年以后的 ms 都 > 1e11）
  if (n >= 1e9) return n * 1000;  // 秒
  return 0;                       // 认不出来就当没有，别拿它做判断
}

if (!KEY) { console.error('缺 WX_QUEUE_TOKEN（在 all48-live-sync/live-notify.env 里）'); process.exit(1); }

/* ---------------- 调 CLI ---------------- */

/** 跑一次 wx 子命令，拿 stdout。超时兜底，避免 daemon 卡死时整个桥停住。 */
function wx(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const p = spawn(WX, args, {
      env: { ...process.env, XDG_CONFIG_HOME: XDG },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { } reject(new Error('wx 超时 ' + args.join(' '))); }, timeout);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) return resolve(out);
      /* 🔴 400 字：`messages send` 失败时会先打一行 `Submission receipt: …`
         再打真正的错误，截 200 字常常只剩 receipt、看不到原因（2026-11-14 排查「回群失败」）。 */
      reject(new Error(`wx 退出码 ${code}：${(err || out).trim().slice(0, 400)}`));
    });
  });
}

/** CLI 有时会在 JSON 前面打一行「Submission receipt: ...」，所以不能直接 JSON.parse */
function jsonOf(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { }
  const i = s.lastIndexOf('\n{');
  if (i >= 0) { try { return JSON.parse(s.slice(i + 1)); } catch { } }
  const j = s.indexOf('{');
  if (j >= 0) { try { return JSON.parse(s.slice(j)); } catch { } }
  return null;
}

/* ---------------- 指令识别 ---------------- */

/** 只认 `LG?名字` / `lg 名字` / `鸡腿?名字` / `rb?名字`，必须带名字；其余一律不理。
 *  规则抄自 qqbot/bot.mjs（那边踩过三个坑，别各写一套）：
 *    1) 全角 `ＬＧ？` 要归一化，不然中文输入法下整条静默；
 *    2) 无分隔符时必须**中文起头**，否则 `lgtm` / `lgbt` 会被当成查「tm」「bt」；
 *    3) 光一个 `lg` 也放行，让 lv 回「用法」。
 *  返回 {kind:'lg'|'rb', name} 或 null。 */
function cmdOf(raw) {
  const s = String(raw || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角→半角
    .replace(/[\u2005\u00a0]/g, ' ')
    .trim();
  // rb 只查成员/队伍，用问号或空格都行
  let m = /^rb\s*[?？:：,，.。、!！]?\s*([\s\S]*)$/i.exec(s);
  if (m) return { kind: 'rb', name: String(m[1] || '').trim().slice(0, 60) || ' ' };
  // 年度之星（MVP）：mvp?名字 / mvp?top20 / mvp?TEAM G，中文「年度之星?」也认
  m = /^(?:mvp|年度之星)\s*[?？:：,，.。、!！]?\s*([\s\S]*)$/i.exec(s);
  if (m) return { kind: 'mvp', name: String(m[1] || '').trim().slice(0, 40) || ' ' };
  m = /^(?:lg|鸡腿)\s*[?？:：,，.。、!！]\s*([\s\S]*)$/i.exec(s);
  if (m) return { kind: 'lg', name: String(m[1] || '').trim().slice(0, 60) || ' ' };
  m = /^(?:lg|鸡腿)\s*([\u4e00-\u9fa5·][\s\S]*)$/i.exec(s);
  if (m) return { kind: 'lg', name: String(m[1] || '').trim().slice(0, 60) };
  if (/^(?:lg|鸡腿)$/i.test(s)) return { kind: 'lg', name: ' ' };
  /* fy?… 查发言（2026-11-13 站长：「fy？用来查询个人 队伍的发言」）
     · `fy` 可省分隔符：fy niii / fy?niii / fy：林舒晴
     · 中文「发言」必须带问号 —— 「发言的人…」是在问话，不能当指令吃掉 */
  m = /^fy\s*[?？:：,，.。、!！]?\s*([\s\S]*)$/i.exec(s);
  if (m) return { kind: 'fy', name: String(m[1] || '').trim().slice(0, 60) || ' ' };
  m = /^发言\s*[?？:：,，.。、!！]\s*([\s\S]*)$/.exec(s);
  if (m) return { kind: 'fy', name: String(m[1] || '').trim().slice(0, 60) || ' ' };
  return null;
}

/* ---------------- 云端指令前缀表（2026-11-12） ----------------
   桥不再硬编码「哪些词算指令」：启动后每 10 分钟从 worker 拉一次 KV `wxcmd:spec`。
   ⇒ 以后加指令：worker 里写解析 + KV 里加个前缀，**那台机器完全不用碰**。
   🔴 拉不到就用内置默认（和以前的硬编码完全一致），行为不会退化。 */
const SPEC_FILE = `${XDG}/state/wxspec.json`;
const SPEC_DEFAULT = ['lg', '鸡腿', 'rb', 'mvp', '年度之星'];
const SPEC_TTL = 3 * 60 * 1000;
/* usage：前缀 → 用法文案，全部云端下发（2026-11-13「gy 查询指令」被当成人名去查名册）。
   桥只负责「把云端那段贴出来」，文案一个字都不硬编码。 */
let SPEC = { at: 0, prefixes: SPEC_DEFAULT.slice(), v: 0, usage: {} };
const specUsage = (o) => {
  const out = {};
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    for (const k of Object.keys(o).slice(0, 12)) {
      const v = String(o[k] || '');
      if (k && v) out[String(k).slice(0, 20)] = v.slice(0, 600);
    }
  }
  return out;
};
try {
  const f = JSON.parse(readFileSync(SPEC_FILE, 'utf8'));
  if (f && Array.isArray(f.prefixes) && f.prefixes.length) {
    SPEC = { at: Number(f.at) || 0, prefixes: f.prefixes, v: Number(f.v) || 0, usage: specUsage(f.usage) };
  }
} catch { /* 首次没有缓存，用内置默认 */ }

function specSave() {
  try {
    mkdirSync(dirname(SPEC_FILE), { recursive: true });
    writeFileSync(SPEC_FILE, JSON.stringify({ at: SPEC.at, prefixes: SPEC.prefixes, v: SPEC.v, usage: SPEC.usage }));
  } catch { /* 写不了也不影响运行 */ }
}

async function loadSpec(force) {
  if (!force && Date.now() - SPEC.at < SPEC_TTL) return;
  try {
    const u = new URL(WORKER + '/api/wxcmd/spec');
    u.searchParams.set('k', KEY);
    const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j && j.ok && Array.isArray(j.prefixes)) {
      const list = j.prefixes.filter((x) => typeof x === 'string' && x.trim());
      SPEC = { at: Date.now(), prefixes: list, v: Number(j.v) || 0, usage: specUsage(j.usage) };
      specSave();
      log(`指令表已更新（v${SPEC.v}）：${list.join(' / ') || '（空）'}`
        + `；用法 ${Object.keys(SPEC.usage).length} 条`);
    }
  } catch (e) {
    log('拉指令表失败（继续用本地表）：' + (e && e.message));
  }
}

/** 原文是否以「云端登记的前缀」开头。命中返回 {kind:'raw', name:原文}。
 *  这里只做粗筛——具体怎么查、文案长什么样，全在 worker / lv 站。
 *  `lgtm` 这类不命中（紧跟的字符必须是分隔符或中文），和原来 cmdOf 的规则一致。 */
function cloudCmd(raw) {
  if (!SPEC.prefixes.length) return null;
  const s = String(raw || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\u2005\u00a0]/g, ' ')
    .trim();
  if (!s) return null;
  const low = s.toLowerCase();
  const hit = SPEC.prefixes.some((x) => {
    const p = String(x || '').toLowerCase().trim();
    if (!p || !low.startsWith(p)) return false;
    const nx = low.charAt(p.length);
    return nx === '' || /[\s?？:：,，.。、!！\u4e00-\u9fa5]/.test(nx);
  });
  return hit ? { kind: 'raw', name: s } : null;
}

/* ── 云端配置（2026-11-12 站长准则：「所有的配置都由云端下发，那台本地机器不做任何配置」）
   ⇒ **云端是唯一真源**：群白名单、推送路由、冷却、AI 额度、机器人称呼、取件间隔，
     全部由 KV `wxcfg:main` 整份下发，桥只负责照着跑。
   本地唯一保留的东西是「机器环境」——wx 可执行文件、账号名、状态目录、云端地址与钥匙，
   这些是连上云端的前提，本身不能云端化（钥匙不能从它要保护的门里取）。
   🔴 可靠性：拉到就先落盘（`XDG/state/wxcfg.json`）。下次启动先读缓存再拉云端，
     所以云端抖动、网络断一会儿都不会让机器人「失忆」变成无白名单裸奔。
   🔴 字段缺失时用**内置默认**补齐，绝不用本地 env 的旧值 —— 否则又变回「本地也算一个源」。 */
const CFG_FILE = `${XDG}/state/wxcfg.json`;
const CFG_DEFAULTS = {
  groups: [],                 // [] = 小号所在的所有群都认指令
  requireMention: false,
  cooldown: 1500,
  aiDaily: 120,
  botNames: ['boooot', '小48', '机器人', '48bot'],
  pushGroups: [],
  pushMap: {},
  pushEvery: 6000,
};

/** 上次成功下发的配置（落盘）。启动先吃它，断网也不至于没配置。 */
let cachedCfg = null;
try {
  const j = JSON.parse(readFileSync(CFG_FILE, 'utf8'));
  if (j && typeof j === 'object') cachedCfg = j;
} catch { cachedCfg = null; }

/** 把云端给的那份 JSON 规整成**完整**配置（缺的补默认，脏的丢掉）。 */
function cfgNormalize(c) {
  const o = (c && typeof c === 'object') ? c : {};
  const arr = (v, def) => (Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : def);
  const num = (v, def, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const map = {};
  if (o.pushMap && typeof o.pushMap === 'object' && !Array.isArray(o.pushMap)) {
    for (const [k, v] of Object.entries(o.pushMap)) {
      const gk = String(k || '').trim();
      if (!gk) continue;
      map[gk] = Array.isArray(v) ? v.map((x) => String(x == null ? '' : x).trim()).filter(Boolean) : [];
    }
  }
  return {
    v: Number(o.v) || 1,
    groups: arr(o.groups, CFG_DEFAULTS.groups),
    requireMention: !!o.requireMention,
    cooldown: num(o.cooldown, CFG_DEFAULTS.cooldown, 500, 60000),
    aiDaily: num(o.aiDaily, CFG_DEFAULTS.aiDaily, 1, 5000),
    botNames: arr(o.botNames, CFG_DEFAULTS.botNames).map((x) => x.toLowerCase()),
    pushGroups: arr(o.pushGroups, CFG_DEFAULTS.pushGroups),
    pushMap: map,
    pushEvery: num(o.pushEvery, CFG_DEFAULTS.pushEvery, 3000, 600000),
  };
}

/** 整份套用（不是「只覆盖写了的字段」——云端说什么就是什么） */
function cfgApply(c) {
  const x = cfgNormalize(c);
  GROUPS = x.groups;
  REQUIRE_MENTION = x.requireMention;
  COOLDOWN = x.cooldown;
  AI_DAILY = x.aiDaily;
  BOT_NAMES = x.botNames;
  PUSH_GROUPS = x.pushGroups;
  PUSH_MAP = new Map(Object.entries(x.pushMap));
  PUSH_EVERY = x.pushEvery;
  return x;
}

let cfgSig = '';
async function loadCfg(verbose = false) {
  try {
    const u = new URL(WORKER + '/api/wxcfg');
    u.searchParams.set('k', KEY);
    const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => null);
    if (!d || !d.ok) { if (verbose) log('云端配置：读不到' + (cachedCfg ? '，沿用上次缓存' : '，用内置默认')); return false; }
    const raw = d.cfg;
    if (!raw || !Object.keys(raw).length) { if (verbose) log('云端配置：还是空的（未初始化），用缓存/默认'); return false; }
    const x = cfgApply(raw);
    try {
      mkdirSync(dirname(CFG_FILE), { recursive: true });
      writeFileSync(CFG_FILE, JSON.stringify(x));
    } catch (e) { log('缓存云端配置失败：' + (e && e.message)); }
    cachedCfg = x;
    const sig = JSON.stringify(x);
    if (sig === cfgSig) { if (verbose) log('云端配置：无变化'); return true; }
    cfgSig = sig;
    log(`配置已下发（云端 v${x.v}）：指令群=${GROUPS.join(',') || '全部'}　`
      + `推送=${[...PUSH_MAP.entries()].map(([g, ws]) => g + '←' + wsDesc(ws)).join('，') || PUSH_GROUPS.join(',') || '关'}　`
      + `冷却=${COOLDOWN}ms　AI/天=${AI_DAILY}　取件=${Math.round(PUSH_EVERY / 1000)}s`);
    return true;
  } catch (e) {
    if (verbose) log('云端配置拉取失败（' + String((e && e.message) || e).slice(0, 80) + '），沿用缓存/默认');
    return false;
  }
}

/* ---------------- 去重 & 限流 ---------------- */

const done = new Map();          // messageId -> ts
function seen(id) {
  const now = Date.now();
  for (const [k, t] of done) if (now - t > 300000) done.delete(k);
  if (done.has(id)) return true;
  done.set(id, now);
  return false;
}
const lastSent = new Map();       // chatId -> ts
/* 🔴 微信「服务端拒收」（service_rejected，2026-11-14 事故）：不是发得太快、不是内容问题，
   而是**这个号被微信限流/风控**了 —— 换群、换内容、重试都没用，越试越重。
   ⇒ 连 2 次就进冷却，时长按级翻倍（20 → 40 → 80 → 160 分钟，封顶 4 小时）；
     冷却期间**完全不取件**，推送留在云端队列里（/api/wxb 取件才清空）；
     冷却结束后的第一轮就是「探针」：能发出去就把等级清零，还被拒就再翻倍。
   推送已收缩到 1 个群 / 60 秒（wxcfg:main），正常时一天也就几十次发送。 */
let rejectStreak = 0;
let pushPauseUntil = 0;
let pauseLevel = 0;                        // 0 = 没在冷却；每升一级时长翻倍
let lastSayRejected = false;               // 本次 say() 是不是「微信拒收」，供上层决定别补发
const PAUSE_BASE = 20 * 60 * 1000;
const PAUSE_CAP = 4 * 60 * 60 * 1000;
function noteReject() {
  rejectStreak++;
  if (Date.now() < pushPauseUntil) return;     // 已在冷却，别重复加码
  if (rejectStreak < 2) return;                // 一次可能是偶发（超时/网络），两次才算限流
  pauseLevel = Math.min(pauseLevel + 1, 8);
  const ms = Math.min(PAUSE_BASE * Math.pow(2, pauseLevel - 1), PAUSE_CAP);
  pushPauseUntil = Date.now() + ms;
  /* 冷却期间攒着的补发队列清掉：解封后一次性倒进群里既刷屏又过时，
     而且「开播了/下播了」这种消息过了半小时本来就没有意义。 */
  try { retryJobs.length = 0; } catch { }
  log(`⚠️ 微信拒收（连续 ${rejectStreak} 次 service_rejected）⇒ 暂停推送 ${Math.round(ms / 60000)} 分钟`
    + `（第 ${pauseLevel} 级）。这是小号被微信限流/风控，不是桥坏了；`
    + '推送留在云端队列，解封后自然补上。');
}

/* ---------------- AI 聊天 ---------------- */

const fmtNum = (n) => String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const aiHist = new Map();        // chatId -> [{role, content}]
const aiQuota = new Map();       // `${chatId}:${ymd}` -> 次数
let ctxCache = { at: 0, text: '' };

/* ── 群内长期记忆（「自我学习」，2026-11-12 站长要求）──────────────────────
   光靠 8 条对话历史，重启就忘：群友昨天给它起的外号、自己定的称呼、常用梗全没了。
   做法是最笨但可靠的一种 —— **关键词触发提炼 + 落盘 + 每轮回注**：
     · 只有句子里出现「记住 / 以后 / 叫我 / 叫你 / 称呼 / 外号」才让模型提炼一次
       （低频，不烧额度；闲聊不会触发）；
     · 提炼结果存本地 JSON（进程重启、换人问都还在），每群最多 30 条；
     · 每次回复前把它们塞进 system，它就知道「陈淑钰要叫王子殿下」这种事。
   🔴 不做「把整段聊天丢进去向量化」那一套：小号在群里，天天自学习会烧额度、还会学歪。 */
const LEARN_FILE = String(process.env.WX_LEARN_FILE || `${XDG}/state/wxlearn.json`);
const LEARN_MAX = 30;
let learn = {};
try { learn = JSON.parse(readFileSync(LEARN_FILE, 'utf8')) || {}; } catch { learn = {}; }

function learnSave() {
  try {
    mkdirSync(dirname(LEARN_FILE), { recursive: true });
    writeFileSync(LEARN_FILE, JSON.stringify(learn));
  } catch (e) { log('存群内记忆失败：' + (e && e.message)); }
}

function learnCtx(chat) {
  const f = (learn[chat] && Array.isArray(learn[chat].facts)) ? learn[chat].facts : [];
  if (!f.length) return '';
  return '【你在这个群里学到的事·长期记忆，当真事用】\n' + f.map((x) => '· ' + x).join('\n');
}

/** 从一轮对话里提炼值得长期记住的群内信息（外号/称呼/约定/梗）。失败静默。 */
async function learnFrom(chat, q, a) {
  if (String(process.env.AI_LEARN || '1') === '0') return;
  if (!/记住|记一下|以后|叫我|叫你|称呼|外号|别名|叫他|叫她|我们叫/.test(q)) return;
  try {
    const sys = '你是信息抽取器。从群聊里抽出【值得长期记住的群内约定】：成员的外号/称呼、'
      + '群友要求机器人怎么说话、固定的梗。每条一行，最多 3 条，用「A = B」或一句陈述。'
      + '只输出条目，不加解释；没有值得记的就只回 NONE。';
    const r = await fetch(WORKER + '/api/ai?k=' + encodeURIComponent(KEY), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: '群友：' + q + '\n机器人：' + a, sys, hist: [] }),
      signal: AbortSignal.timeout(30000),
    });
    const d = await r.json().catch(() => null);
    const txt = String((d && d.reply) || '').trim();
    if (!txt || /^NONE/i.test(txt)) return;
    const cur = (learn[chat] && Array.isArray(learn[chat].facts)) ? learn[chat].facts.slice() : [];
    let added = 0;
    for (const ln of txt.split('\n').map((s) => s.replace(/^[-·•\d.\s]+/, '').trim()).filter(Boolean)) {
      if (ln.length < 4 || ln.length > 60) continue;
      if (cur.some((x) => x === ln)) continue;
      cur.push(ln); added++;
    }
    if (!added) return;
    learn[chat] = { facts: cur.slice(-LEARN_MAX), at: Date.now() };
    learnSave();
    log(`学到 ${added} 条群内记忆（${chat}，共 ${learn[chat].facts.length} 条）`);
  } catch (e) { log('学习失败：' + (e && e.message)); }
}

/* ── 本群专属「回复后缀」（2026-11-14）─────────────────────────────────
   站长：「在群里跟机器人开玩笑，比如加个什么后缀，这个不要同步到别的群」。
   ⇒ 存在 learn[chat].suffix，key 就是群 id：别的群读不到、也不会被带去，
     不进全局 system prompt、不进云端配置，**天然按群隔离**。
   用法（只认这几种说法，避免把「这个后缀不错」这种闲聊当成设置）：
     后缀 ob 是笨蛋 / 回复后缀要加上 ob 是笨蛋 / 后缀? xxx
     后缀            ← 看当前这个群有没有
     后缀 清空        ← 只清这个群 */
const SUF_HEAD = /^(?:(?:给我|你的|机器人的)?回复)?(?:后缀|尾巴)(?=$|[\s\u2005?？:：,，=]|(?:要|就)?(?:加上|加|改成|改为|设成|设为|设置成))/;
function suffixSet(chat, raw) {
  const s = String(raw || '').trim();
  const m = SUF_HEAD.exec(s);
  if (!m) return null;
  const rest = s.slice(m[0].length).replace(/^[\s\u2005?？:：,，=]+/, '').trim();
  const cur = String((learn[chat] && learn[chat].suffix) || '');
  if (!rest) {
    return cur
      ? '这个群现在的后缀：「' + cur + '」\n（只在这个群生效；发「后缀 清空」可以去掉）'
      : '这个群还没设后缀。发「后缀 ob 是笨蛋」这样设一条，只在这个群生效。';
  }
  if (/^(?:清空|清除|去掉|关掉|取消|删除|不要了|无|none)$/i.test(rest)) {
    if (learn[chat]) { delete learn[chat].suffix; learnSave(); }
    return '好，这个群的后缀去掉了（别的群本来就没受影响）。';
  }
  let txt = rest.replace(/^(?:要|就)?(?:加上|加|改成|改为|设置成|设成|设为|用|是|为)[\s\u2005]*/, '').trim();
  txt = txt.replace(/^[「『"'（(]+/, '').replace(/[」』"'）)]+$/, '').trim();
  if (!txt) return '后缀写空啦，再发一次试试。';
  if (txt.length > 30) return '后缀太长（' + txt.length + ' 字），30 字以内吧。';
  learn[chat] = { ...(learn[chat] || {}), suffix: txt, at: Date.now() };
  learnSave();
  log('设置本群后缀（' + chat + '）：' + txt);
  return '好，以后在这个群说话末尾带「' + txt + '」。\n只对这个群生效，别的群我不会带上～';
}

/** 榜单摘要（5 分钟缓存）——让模型能答「谁第一 / 哪队领先」，不用它自己瞎猜 */
async function boardCtx() {
  if (Date.now() - ctxCache.at < AI_CTX_TTL) return ctxCache.text;
  try {
    const res = await fetch(WORKER + '/api/gift?limit=12', { signal: AbortSignal.timeout(20000) });
    const d = await res.json();
    const top = (d.rank || []).slice(0, 12).map((x, i) => (i + 1) + '.' + x.name + ' ' + fmtNum(x.score));
    const tm = (d.teams || []).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, 8).map((x) => (x.tm || x.g) + ' ' + fmtNum(x.score));
    ctxCache = {
      at: Date.now(),
      text: '【当前红蓝累计 ' + (d.from || '') + '~' + (d.to || '') + '】\n成员前12：' + top.join('、') +
        '\n队伍前8：' + tm.join('、'),
    };
  } catch {
    ctxCache = { at: Date.now(), text: '' };
  }
  return ctxCache.text;
}

/** 成员资料（AI 用）—— 从 /api/mem 拿：团队/期数 + 最近房间发言 + 红蓝分。
 *  只有问句里出现中文人名才去查（省一次请求），命中不到就返回空串。 */
async function memCtx(q) {
  if (!/[\u4e00-\u9fa5]{2,}/.test(q)) return '';
  try {
    const u = new URL(WORKER + '/api/mem');
    u.searchParams.set('k', KEY);
    u.searchParams.set('q', q);
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const d = await res.json().catch(() => null);
    if (!d || !d.ok) return '';
    const L = ['【成员资料·本站真实数据】',
      d.name + '｜' + (d.g || '') + ' ' + (d.tm || '') + (d.ot ? '（原队 ' + d.ot + '）' : '') + '｜' + (d.pd || '')];
    if (d.rb) L.push('红蓝：' + d.rb);
    /* 她自己的鸡腿 / 公演（2026-11-13）：资料里以前只有红蓝，问「她鸡腿什么水平」
       模型只能答「没有数据」。带上周环比，才能回答「最近涨了还是掉了」。 */
    try {
      const [l1, g1] = await Promise.all([
        apiJson('/api/cmd?q=' + encodeURIComponent('lg?' + d.name), 12000),
        apiJson('/api/cmd?q=' + encodeURIComponent('gy?' + d.name), 12000),
      ]);
      if (l1 && l1.ok && typeof l1.week === 'number') {
        const wk = l1.week, pv = Number(l1.prev) || 0;
        const wc = pv > 0
          ? `，上周 ${fmtNum(pv)}（${wk >= pv ? '+' : ''}${(((wk - pv) / pv) * 100).toFixed(0)}%）`
          : '';
        L.push(`鸡腿（房间+直播，不含公演）：今日 ${fmtNum(l1.today)}，近7天 ${fmtNum(wk)}${wc}`);
      }
      if (g1 && g1.ok && g1.reply && !/没有公演/.test(String(g1.reply))) {
        const ln = String(g1.reply).split('\n');
        const head = ln[0] ? ln[0].replace(/^【|】$/g, '') : '';
        L.push('公演鸡腿｜' + head.replace(/^公演[·•]\s*/, '')
          + (ln[1] ? '｜' + ln[1].replace(/^公演鸡腿\s*/, '') : ''));
      } else if (g1 && g1.ok) {
        L.push('公演鸡腿：近 7 天没有她的公演记录');
      }
    } catch { /* 取不到就不写这一块 */ }
    /* 🔴 直播结论单独一屏、放最前面（2026-11-12 实测：只在资料中间写一句「此刻没在播」，
       模型照样答「最近在直播」；改成「结论 + 上次播的时间 + 禁用词表」后连续两次都答对）。 */
    L.push('【直播结论·可以直接说给群友】');
    L.push(Number(d.liveOn) === 1 ? '· 现在：在播（' + d.live + '）' : '· 现在：没有在播');
    if (Array.isArray(d.vod) && d.vod.length) L.push('· 上次播：' + d.vod[0]);
    L.push('🔴 任何涉及直播的回答都以这里为准；除非上面写着「在播」，'
      + '否则严禁出现「在直播」「正在播」「刚开播」「直播中」这类说法。');
    if (Array.isArray(d.vod) && d.vod.length) {
      L.push('最近回放（共 ' + (d.vodN || d.vod.length) + ' 场）：');
      d.vod.forEach((s) => L.push('· ' + s));
    }
    if (Array.isArray(d.say) && d.say.length) {
      L.push('她最近在口袋48房间说过的话（最新在前，共 ' + (d.sayN || d.say.length) + ' 条；'
        + '都是过去时，别当成现在）：');
      d.say.slice(0, 8).forEach((s) => L.push('· ' + s));
    }
    /* 🔴 两条防串台的硬约束（2026-11-12 实测事故：群里问「陈淑钰最近在干嘛」，
       答的全是王语晨的原话「今天再头痛也要凑一天」—— 前端拿到的是对的资料，
       模型把**历史对话里另一个人的话**安到了当前这个人头上）。 */
    L.push('🔴 上面全部是【' + d.name + '】一个人的资料，本轮只谈她一个人；'
      + '历史对话里出现过的其他成员与你无关，她们说过的话、行程、分数一个字都不许安到' + d.name + '身上。');
    if (!d.live) L.push('🔴 资料里没有直播信息，不许说她正在直播或刚开播。');
    L.push('聊到她的具体事就照上面的原话（带日期就照日期说），别加戏；单纯陪聊不用被这些限制。');
    return L.join('\n');
  } catch { return ''; }
}

const AI_SYS = [
  '你是「弦月回响·红蓝歌会」粉丝群里的机器人助手，群友叫你小48。',
  '像群里一个熟悉48的老粉那样聊天：简体中文口语、短句、有梗，一次不超过 80 字，不要 markdown 标题/表格/列表符号。',
  '🔴 别夹英文单词（realtime / ok / list 这种），群聊里说中文就行。',
  '🔴 首要任务是**陪玩**：群友逗你、给你起外号、让你改口叫某成员「王子殿下」「老婆」「姐」这种，就顺着接梗、照叫、开玩笑。'
  + '绝对不要说「我只认红蓝榜上的名字」「查不到」「请先查鸡腿」这类扫兴话——那不是在保护数据，是在把天聊死。',
  '日常闲聊放开了聊——打招呼、吐槽、玩梗、安利、陪聊情绪都可以，别端着，也别把话题拽回榜单。',
  '被问「你是谁」就说自己是群里的助手小48；🔴 不要自称「红蓝榜机器人」，也不要在句尾反问「要查鸡腿吗」——没人问你数据就别提。',
  '你熟悉的规则：红蓝计分 = 弦月回响礼物份数 + 琴音生花礼物数（每个 1 分）；',
  '群指令：lg?名字 查鸡腿、rb?名字 查红蓝、mvp?名字 查年度之星（mvp?top20 看总榜、mvp?TEAM G 看队内）、'
  + 'rb?group 看全团排名、rb?top64 看全站前64、rb?gnz 看团内全员、rb?队伍（niii / 广州联合 / 川渝联合）。'
  + '🔴 除非对方明显在问数据，**不要主动推销这些指令**。',
  '🔴 下面系统会**一直**附【实时·最近 5 分钟】和【实时·最近 30 分钟】两份谁在说话的名单。'
  + '群友用任何说法问「现在/刚才谁在发言、最近几分钟有没有人说话、谁冒泡、在聊什么」，'
  + '就按他问的时间窗挑最接近的那份照答（问 5 分钟看 5 分钟那份，问半小时看 30 分钟那份；'
  + '某档为空就说那段时间没人说话）；🔴 名单里没有的名字一个都不许编，也不许推 rb?top64 这类指令。'
  + '🔴 群友没问就别主动念名单——只是给你备着的资料，闲聊时别提。',
  '🔴 涉及成员的具体事实（她真的说了什么、行程、分数、排名、哪天直播）只能来自下面【】里的真实数据；数据没有就说「这个我还真不知道」或反问，绝不编。',
  '🔴 **鸡腿和红蓝是两套完全不同的数据**：资料里的「红蓝」永远是红蓝分，绝不能当鸡腿分说出口；'
  + '问到鸡腿而资料里没有鸡腿数字，就说「鸡腿我这边没拿到，你发 lg?名字 查一下」，别拿红蓝数字凑。',
  '🔴 引用她说的话必须是资料里的原话，日期按资料里的写；「刚刚/今天/正在」只能用于资料里就是当天且在播的情况。',
  '🔴 资料只描述一个人时，只谈这一个人：不要把之前聊过的人的事混进来。',
  '站外信息（天气、新闻、股价）你查不到：直接说查不到、让群友自己看，绝不要编具体数值或结论。',
  /* 🔴 2026-11-12 事故：问「最近五分钟说话的成员」，模型答「小草莓、小番茄、小西瓜、小芒果」——
     一个真人都没有，全是编的。数据类的名单/人名一律不许凭空产生。 */
  '🔴🔴 绝对不许编人名：凡是名单（谁在说话、在线、发言的人、排名里的名字），只能用下面【】里列出来的真名；'
  + '名单没给到你，就说「实时名单我这次没取到，再问我一次」，🔴 一个编出来的名字都不许出现。',
].join('\n');

/* ---------------- 「谁在说话」问法识别（供 naturalCmd 与 askAI 共用） ---------------- */

/** 中文数字/阿拉伯数字 → 数值（「五」5、「十五」15、「半」0.5、「20」20） */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cn2n(raw) {
  const t = String(raw || '').trim();
  if (!t) return NaN;
  if (/^\d+$/.test(t)) return Number(t);
  if (t === '半') return 0.5;
  if (t.indexOf('十') >= 0) {
    const p = t.split('十');
    const hi = p[0] ? (CN_DIGIT[p[0]] ?? 0) : 1;
    const lo = p[1] ? (CN_DIGIT[p[1]] ?? 0) : 0;
    return hi * 10 + lo;
  }
  return t.length === 1 ? (CN_DIGIT[t] ?? NaN) : NaN;
}

/** 从一句话里抠时间窗（分钟，上限 720）。必须认中文数字：
 *  站长原话是「最近**五**分钟」—— 旧代码只写 `\d+`，连分钟数都读不到。 */
function parseMin(s, def = 5) {
  const m = /(\d+|[零一二两三四五六七八九十半]+)\s*个?\s*(分钟|分|min|小时|钟头|h|天|日)/i.exec(String(s || ''));
  if (!m) return def;
  const n = cn2n(m[1]);
  if (!isFinite(n) || n <= 0) return def;
  let mul = 1;
  if (/小时|钟头|^h$/i.test(m[2])) mul = 60;
  else if (/天|日/.test(m[2])) mul = 1440;
  return Math.min(720, Math.max(1, Math.round(n * mul)));
}

/* 🔴 「最近五分钟说话的成员」这类必须被认出来（2026-11-12 实测翻车：
   旧正则只认「谁在说话」的**语序**，这句话里既没「谁」也没「哪些」，
   于是整句掉进 AI —— 模型凭空报了四个不存在的名字）。三种语序都收：
   ① 谁/哪些/有没有人 + 说话；② 说话的成员 / 发言的人 / 冒泡的都有谁；
   ③ 时间窗 + 说话 + 名单词（顺序不定，用前瞻拼）。 */
const WHO_ASK = new RegExp([
  '(?:谁|哪些(?:成员|人)?|哪个(?:成员|人)?|有没有(?:人|成员)?|有(?:人|成员)|几个人)在?(?:说话|发言|聊天|冒泡|讲话|开麦)',
  '(?:说话|发言|聊天|冒泡|讲话|开麦)的?(?:成员|人|都有谁|有谁|名单)',
  '(?=[\\s\\S]*(?:说话|发言|聊天|冒泡|讲话|开麦))'
  + '(?=[\\s\\S]*(?:最近|近\\s*(?:\\d|[一二两三四五六七八九十半])|过去|刚刚|刚才|现在|今天))'
  + '(?=[\\s\\S]*(?:谁|哪些|哪个|几个|成员|名单|人数|的人))',
  '谁(?:在)?在线|在说话的|热闹吗|活跃吗',
].join('|'), 'i');

/* 「最近10分钟有发言的」「最近30分钟有说话的」——没有「谁/成员/名单」这类词，
   但带**明确时间量** + 说话动词，同样是在问名单（2026-11-12 站长连问两次都掉进 AI）。 */
const WHO_ASK_QTY = new RegExp(
  '(?=[\\s\\S]*(?:最近|近|过去|刚刚|刚才|现在|今天)\\s*(?:\\d+|[零一二两三四五六七八九十半]+)\\s*个?\\s*'
  + '(?:分钟|分|小时|钟头|h|天|日))(?=[\\s\\S]*(?:说话|发言|聊天|冒泡|讲话|开麦))', 'i');

/** 统一判定「这是不是在问谁在说话」。🔴 要「原话/说了什么」的**不是查名单**，
 *  那种走 sayRaw 直出原文，不能被 who 抢走（「王语晨最近三天的发言原话」）。 */
function isWhoAsk(s) {
  const t = String(s || '');
  if (/原话|说了什么|说了啥|说过什么|发言内容|聊了什么/.test(t)) return false;
  return WHO_ASK.test(t) || WHO_ASK_QTY.test(t);
}

/** 机器人自己的名字（群昵称）。🔴 必须配：很多人是**手打**「@boooot」而不是点选 @，
 *  微信这时不给 atuserlist（`mentions.self=false`），只按协议判断会整条静默 ——
 *  2026-11-12 实测：站长手打 `@boooot 黄宣绮 最近3天的发言内容原话`，桥一声不响。 */
let BOT_NAMES = String(process.env.WX_BOT_NAMES || 'boooot,小48,机器人,48bot')
  .split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

/* 🔴 自然语言查询：「帮我查陈淑钰的鸡腿」「niii 现在多少鸡腿」
   （2026-11-12 实测翻车：这句话走到 AI，模型拿红蓝分冒充鸡腿答「425 分、全场 77 名」）。
   规则：句子里出现「鸡腿」→ 当 `lg?`；出现「红蓝/票数」→ 当 `rb?`；两者都有按**靠后**的那个算
   （「红蓝和鸡腿各多少」这种没法一句答，取最后提到的）。
   目标优先认队/团名（lv 直接支持），认不到再用 /api/mem 的最长匹配找人名；
   两个都没有 ⇒ 返回 null 交给 AI（「鸡腿是什么」这种闲聊不该被当成查询）。 */
async function naturalCmd(q) {
  const s = String(q || '');
  /* 「现在谁在说话 / 最近 5 分钟有没有人发言 / 最近五分钟说话的成员」—— 直接查热窗，别交给模型。
     2026-11-12 站长实测：问这个，模型回「实时我可查不到～你发 rb?top64」，
     其实 hot:all 里每一分钟谁说过话都有；换个语序（「说话的成员」）模型干脆编名字。 */
  /* 「上午11点发言的人呢」「昨天下午3点谁在说话」——先认钟点，再认「最近 N 分钟」。
     只报钟点没别的词（「我11点下课」）不算查询。 */
  const team = teamOf(s);
  const wq = parseWhen(s);
  const WHO_VERB = /(说话|发言|聊天|冒泡|讲话|开麦|在线|活跃|消息|谁|哪些|名单|吗|呢|？|\?)/;
  /* 🔴 问榜单的别被「谁/今天」抢走（「今天谁的红蓝最高」不是查发言名单） */
  const dataQ = /鸡腿|红蓝|票数|投票|打投|mvp|年度之星|星梦值|榜|排名|第几|多少分/i.test(s);
  /* 🔴 「黄宣绮今天说话了吗」问的是**某一个人**，不能当全员名单查
     （2026-11-12 站长实测：回了一整屏「今天全天谁在说话」）。
     判据：有说话动词 + 有时间指代 + **没有泛指词**（谁/哪些/成员/名单/有人…）。
     泛指词在场就说明问的是一群人（「预备生今天发言的人有谁」「最近五分钟说话的成员」）。 */
  const sayVerb = /(说话|发言|冒泡|讲话|开麦|发消息|上过线)/.test(s);
  /* 🔴 `的人` 也算泛指（2026-11-13 站长实测：「队伍 niii 最近发言的人」被当成单人查询，
     把**整句话**当人名丢给 /api/say → 回「这个我没认出来是问谁」）。
     「发言的人 / 说话的人 / 冒泡的人 / 都有谁」问的都是名单，不是某一个人。 */
  const genericQ = /(谁|哪些|哪个|几个|多少人|多少位|名单|大家|有人|成员|都在|都谁|的人)/.test(s);
  const timeRef = /(今天|今日|当天|昨天|昨日|前天|最近|刚才|刚刚|\d{1,2}\s*[月\-\/.]\s*\d{1,2}|\d+\s*天)/.test(s);
  /* 句子里点了队/团名 ⇒ 一定是问队内名单，绝不能当「某个人今天说话了没」。
     （「NIII 的黄宣绮今天说话了吗」会被多列几个人，这个偏差可以接受；
       反过来把整句人名化则是直接答非所问。） */
  if (sayVerb && !genericQ && timeRef && !dataQ && !team) return { kind: 'say', name: s };
  if (wq && !dataQ && WHO_VERB.test(s)) {
    return { kind: 'when', name: JSON.stringify({ team, dayOff: wq.dayOff, h: wq.h, end: wq.end, half: wq.half }) };
  }
  /* 「今天发言的人有谁」「昨天谁在说话」——整天，不是最近 N 分钟 */
  const dayHit = /(今天|今日|昨天|昨日|前天)/.test(s);
  if (dayHit && !dataQ && WHO_VERB.test(s)) {
    const dayOff = /前天/.test(s) ? -2 : (/昨天|昨日/.test(s) ? -1 : 0);
    return { kind: 'when', name: JSON.stringify({ team, dayOff, wholeDay: true }) };
  }
  /* 只报了队伍（「bej 现在谁在说话」）也照队内筛 */
  if (!dataQ && (isWhoAsk(s) || (team && WHO_VERB.test(s)))) {
    return { kind: 'who', name: String(parseMin(s, 5)), team };
  }
  const iLg = s.search(/鸡腿/);
  const iRb = s.search(/红蓝|票数|投票|打投/);
  let kind = '';
  if (iLg >= 0 && (iRb < 0 || iLg > iRb)) kind = 'lg';
  else if (iRb >= 0) kind = 'rb';
  /* 年度之星：没提鸡腿/红蓝、但提到 mvp/年度之星/星梦值 ⇒ 走 mvp */
  if (!kind && /年度之星|mvp|星梦值/i.test(s)) kind = 'mvp';
  if (!kind) return null;

  /* 「全团 / 全员 / 全体」—— `rb?全团` 云端直接出团汇总（2026-11-12 站长群里问「查全团的红蓝」，
     原来这里认不出、落到 AI 回了句「哈喽～想聊啥？」）。lg 暂无全团维度，交给下面走空名给用法。 */
  if (kind === 'rb' && /全团|全员|全体|所有团/.test(s)) return { kind: 'rb', name: '全团' };

  /* 「年度之星第一是谁 / 前 20」这种没有具体人名的，直接给总榜 */
  if (kind === 'mvp' && /第一|谁|排行|榜|前\s*\d+/.test(s)) {
    const tm = /前\s*(\d{1,3})/.exec(s);
    return { kind: 'mvp', name: 'top' + Math.min(50, Number(tm && tm[1]) || 10) };
  }

  /* 队/团名统一走 teamOf：它认「队伍 niii」「team g」「bej队」这些口语写法，
     并且**一律转大写**（原来这里各自匹配一套小写正则，`niii 多少鸡腿` 会把小写原样
     传给 lv，靠下游自己容错；统一口径后少一层隐患）。 */
  const tw = teamOf(s);
  if (tw) return { kind, name: tw };

  try {
    const u = new URL(WORKER + '/api/mem');
    u.searchParams.set('k', KEY);
    u.searchParams.set('q', s);
    const d = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
    if (d && d.ok && d.name) return { kind, name: d.name };
  } catch { }
  /* 认出了是「红蓝 / 鸡腿」，但里面没有具体对象时：
     · 明确在问「怎么用」⇒ 回空名，让云端给**用法**（比丢给 AI 回「哈喽～想聊啥？」有用）
     · 其它情况一律 null 交给 AI —— 免得「今天红蓝好卷」这种闲聊被当成查询刷屏 */
  if (/指令|用法|怎么|如何|怎样|咋查|查什么/.test(s)) return { kind, name: '' };
  return null;
}

/** 最近 N 分钟谁在口袋里说话（/api/who）。带一句原话预览，方便群友接话。
 *  🔴 2026-11-12 事故：全员房间发言由 GitHub Actions **每 15 分钟**抓一轮（`sync.yml` `* /15`），
 *     所以「最近 5 分钟」经常是空的 —— 群里看到的就是「没人说话」（站长连问三次「怎么没有」）。
 *     ⇒ 窗口空了就自动往上扩（5→30→180 分钟），并且在结尾写清「数据最后更新 HH:MM」，
 *     让群友自己判断新不新，而不是让机器人假装实时。 */
async function whoReply(min, team = '') {
  const ask = Math.max(1, Number(min) || 5);
  const ladder = [...new Set([ask, Math.max(ask, 30), Math.max(ask, 180)])];
  let d = null;
  let used = ask;
  for (const m of ladder) {
    const u = new URL(WORKER + '/api/who');
    u.searchParams.set('k', KEY);
    u.searchParams.set('min', String(m));
    u.searchParams.set('n', '20');
    if (team) u.searchParams.set('team', team);
    try { d = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json(); } catch { d = null; }
    used = m;
    if (d && d.ok && d.list && d.list.length) break;
  }
  if (!d || !d.ok) return '实时名单这次没抓到（接口没返回），过一两分钟再问我一次～';
  const at = Number(d.at) || 0;
  const stamp = at ? `\n📡 数据最后更新 ${bjHM(at)}（全员房间每 15 分钟抓一轮）` : '';
  const tag = team ? ` · ${team}` : '';
  if (!d.list || !d.list.length) {
    return `最近 ${used} 分钟${team ? ' ' + team + ' 队内' : ''}口袋房间确实没人说话～` + stamp;
  }
  const m2 = Number(d.min) || used;
  const head = used > ask
    ? `最近 ${ask} 分钟没人说话，往上看到 ${m2} 分钟${tag}：${d.total} 人`
    : `【最近 ${m2} 分钟在说话${tag}】${d.total} 人`;
  const L = [head];
  d.list.slice(0, 15).forEach((x) => {
    const tm = x.tm ? '·' + String(x.tm).replace('TEAM ', '') : '';
    const one = String(x.x || '').slice(0, 34);
    L.push(`${bjHM(x.t)} ${x.n}${tm}` + (one ? `：${one}` : '') + (Number(x.c) > 1 ? `（${x.c}条）` : ''));
  });
  if (d.total > 15) L.push(`…还有 ${d.total - 15} 人`);
  return L.join('\n') + stamp;
}

/* ---------------- 队伍/团名识别（和 rb?/lg? 同一套叫法，可省 48） ---------------- */

/** 「bej 队内」「niii 今天谁在说话」「team g」「g队」「预备生」→ 'BEJ' / 'NIII' / 'G' / '预备生'
 *  🔴 单字母队名（G/Z/X/C/K/B/E）必须带 `team` 或「队」字，否则群里随便一个字母就被当成队。 */
const TEAM_ASK = new RegExp([
  '\\b(snh|gnz|bej|cgt|ckg)(?:48)?\\b',                        // 团名，可省 48
  '\\b(niii|nii|gii|sii|hii|cii|kii|xii)\\b',                   // 四字母队名，直接写就行
  '(?:team\\s*([gzxckbe])\\b|\\b([gzxckbe])\\s*(?:队|组))',      // 单字母：team G / g队
  '(预备生|idft|广州联合|川渝联合)',
].join('|'), 'i');
function teamOf(s) {
  const t = String(s || '');
  /* 🔴 「队伍 niii」「队伍是 g」—— 群里最顺口的说法，原来完全不认（2026-11-13 实测
     「队伍 niii 最近发言的人」被当成单人名去查）。单字母队名靠「队伍」这个前缀才敢认，
     不会像裸字母那样误伤。 */
  const u = /队伍\s*(?:是|为)?\s*([a-z]{1,4})(?![a-z])/i.exec(t);
  if (u) {
    const v = u[1].toUpperCase();
    if (/^(SNH|GNZ|BEJ|CGT|CKG|NIII|NII|GII|SII|HII|CII|KII|XII|[GZXCKBE])$/.test(v)) return v;
  }
  const m = TEAM_ASK.exec(String(s || ''));
  if (!m) return '';
  const v = m[1] || m[2] || m[3] || m[4] || m[5] || '';
  return String(v).toUpperCase();
}


/* ---------------- 「上午 11 点发言的人呢」：绝对时间窗 ---------------- */

/** 从一句话里认出「几点」：返回 { dayOff, h, end, half } 或 null。
 *  🔴 2026-11-12 站长原话「上午11点发言的人呢」—— 只认「最近N分钟」是不够的，
 *     群友会直接报钟点。日期只支持 今天/昨天/前天（热窗每人 30 条、只留 3 天）。 */
function parseWhen(s) {
  const t = String(s || '');
  if (!/[点时]/.test(t)) return null;
  const dm = /(大前天|前天|昨天|今天|昨早|昨晚|今早|今晚)?\s*(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*[点时](半|[0-5]?\d\s*分)?/.exec(t);
  if (!dm) return null;
  let h = cn2n(dm[3]);
  if (!isFinite(h) || h > 24) return null;
  const per = dm[2] || '';
  if (/下午|傍晚|晚上|夜里/.test(per) && h < 12) h += 12;
  if (/中午/.test(per) && h < 11) h += 12;
  if (h >= 24) h = 0;
  let end = h + 1;
  const rng = /(?:到|至|-|~|—)\s*(\d{1,2}|[零一二两三四五六七八九十]{1,3})\s*[点时]/.exec(t);
  if (rng) {
    const h2 = cn2n(rng[1]);
    if (isFinite(h2) && h2 > h && h2 <= 24) end = h2;
  }
  let dayOff = 0;
  const dd = dm[1] || '';
  if (/前天/.test(dd)) dayOff = -2;
  else if (/昨天|昨晚|昨早/.test(dd)) dayOff = -1;
  return { dayOff, h, end, half: /^半/.test(dm[4] || '') };
}

/** {dayOff,h,end,half} 或 {dayOff,wholeDay} → 北京时间毫秒区间 */
function whenRange(w) {
  const bj = new Date(Date.now() + 8 * 3600e3);
  const y = bj.getUTCFullYear();
  const mo = bj.getUTCMonth();
  const d = bj.getUTCDate() + w.dayOff;
  if (w.wholeDay) {
    const from = Date.UTC(y, mo, d, 0, 0) - 8 * 3600e3;
    const to = w.dayOff === 0 ? Date.now() : Date.UTC(y, mo, d + 1, 0, 0) - 8 * 3600e3;
    return { from, to };
  }
  let from = Date.UTC(y, mo, d, w.h, w.half ? 30 : 0) - 8 * 3600e3;
  let to = w.end > w.h ? Date.UTC(y, mo, d, w.end, 0) - 8 * 3600e3 : from + 3600e3;
  if (to <= from) to = from + 3600e3;
  return { from, to };
}

const hhmmOf = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
const dayName = (off) => (off === 0 ? '今天' : off === -1 ? '昨天' : off === -2 ? '前天' : `${off} 天前`);

/** 某个钟点 / 整天区间谁在说话。数据同样来自热窗（每人只留最近 30 条）⇒ 必须说清覆盖范围。 */
async function whenReply(w) {
  const team = String(w.team || '').toUpperCase();
  const { from, to } = whenRange(w);
  const label = (w.wholeDay
    ? `${dayName(w.dayOff)}全天`
    : `${dayName(w.dayOff)} ${hhmmOf(from)}–${hhmmOf(to)}`) + (team ? ` · ${team}` : '');
  if (from > Date.now()) return `${label} 还没到呢～`;
  const u = new URL(WORKER + '/api/who');
  u.searchParams.set('k', KEY);
  u.searchParams.set('from', String(from));
  u.searchParams.set('to', String(to));
  u.searchParams.set('n', '80');
  if (team) u.searchParams.set('team', team);
  let d = null;
  try { d = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json(); } catch { d = null; }
  if (!d || !d.ok) return '这个时段我这次没查到（接口没返回），过一会儿再问我～';
  if (!d.list || !d.list.length) {
    return `${label} 我这边没有发言记录——热窗里每人只留最近 30 条，越早的时段越容易被顶掉；`
      + '想查更早的得翻存档。';
  }
  /* 整天/整段按「谁说得最多」排，别按最后一句的时间排 */
  const list = d.list.slice().sort((a, b) => (Number(b.c) || 0) - (Number(a.c) || 0));
  const L = [`【${label} 在说话】${d.total} 人 · ${d.msgN || 0} 条`];
  list.slice(0, 18).forEach((x) => {
    const tm = x.tm ? '·' + String(x.tm).replace('TEAM ', '') : '';
    L.push(`${x.n}${tm}` + (Number(x.c) > 1 ? `（${x.c}条）` : ''));
  });
  if (d.total > 18) L.push(`…还有 ${d.total - 18} 人`);
  L.push('📡 口径：每人只保留最近 30 条发言，太早的时段可能不全');
  return L.join('\n');
}

/** 给模型看的实时发言摘要（30 分钟窗口，紧凑版）。 */
async function whoCtx(min = 30) {
  try {
    const u = new URL(WORKER + '/api/who');
    u.searchParams.set('k', KEY);
    u.searchParams.set('min', String(min));
    const d = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
    if (!d || !d.ok) return '';
    const stamp = Number(d.at) ? `（数据最后更新 ${bjHM(Number(d.at))}，全员房间每 15 分钟抓一轮）` : '';
    if (!d.list || !d.list.length) {
      return `【实时·最近 ${min} 分钟】没有任何成员在口袋房间发言${stamp}。`;
    }
    const L = [`【实时·最近 ${min} 分钟谁在说话】共 ${d.total} 人`];
    d.list.slice(0, 12).forEach((x) => {
      L.push(`· ${bjHM(x.t)} ${x.n}（${x.g} ${x.tm}）` + (x.x ? '说：' + String(x.x).slice(0, 40) : '（发了消息）'));
    });
    L.push('🔴 这是抓取端最近一批的名单（全员房间每 15 分钟抓一轮，所以可能差几分钟），'
      + '直接照着回答，别说「查不到」或让对方去发榜单指令；被问「现在」就说是刚到的最新一批。');
    return L.join('\n');
  } catch { return ''; }
}

/** 一条消息要不要交给模型：`ai?问题` 前缀、@ 了本号（真 @ 或手打 @名字） */
function aiWanted(m, text) {
  if (!AI_ON) return '';
  const t = String(text || '').trim();
  const pre = /^(?:ai|问|小48)\s*[?？:：,，.。!！]?\s*([\s\S]+)$/i.exec(t);
  if (pre) return pre[1].trim().slice(0, 500);
  const men = m.mentions || {};
  const at = /^@([^\s\u2005]{1,24})[\s\u2005]+/.exec(t);
  const typed = !!(at && BOT_NAMES.some((n) => at[1].toLowerCase().indexOf(n) >= 0));
  if (!men.self && !typed) return '';
  if (men.all && !typed) return '';              // @所有人 不算叫我
  return t.replace(/^@[^\s\u2005]+[\s\u2005]*/, '').replace(/[\s\u2005]+$/, '').slice(0, 500);
}

/* 🔴 「最近N天的发言原话」这类问题**别交给模型**：它会把 40 条原文压成一句
   「她最近在排练」，问原话的群友要的就是逐条原文。命中就直出（2026-11-12 站长实测）。 */
const RAW_ASK = /原话|发言|说话|说了什么|说了啥|说过什么|说过的话|聊了什么|冒泡/;

/** 「11月8日 / 11-8 / 11/8 / 11.8 / 昨天 / 前天 / 今天」→ 北京时间的整天区间。
 *  🔴 2026-11-12 站长问「黄宣绮11月8日发言」，旧逻辑只认「N天」⇒ 回成「最近3天」。
 *     日期一律按**北京时间自然日**切，from/to 都是左闭右开。 */
function bjDayRange(q) {
  const bj = new Date(Date.now() + 8 * 3600e3);
  const y = bj.getUTCFullYear();
  const mk = (yy, mo, dd) => {
    const f = Date.UTC(yy, mo - 1, dd) - 8 * 3600e3;
    return { from: f, to: f + 86400e3 };
  };
  const m = /(?:^|[^\d])(\d{1,2})\s*[月\-\/.]\s*(\d{1,2})\s*[日号]?/.exec(q);
  if (m) {
    const mo = Number(m[1]);
    const dd = Number(m[2]);
    if (mo >= 1 && mo <= 12 && dd >= 1 && dd <= 31) {
      let yy = y;
      let r = mk(yy, mo, dd);
      if (r.from > Date.now() + 86400e3) { yy -= 1; r = mk(yy, mo, dd); }   // 「12月31日」在年初问 = 去年
      return { label: mo + '月' + dd + '日', ...r };
    }
  }
  const off = /前天/.test(q) ? -2 : ((/昨天|昨日/.test(q)) ? -1 : ((/今天|今日|当天/.test(q)) ? 0 : null));
  if (off !== null) {
    const d = new Date(Date.UTC(y, bj.getUTCMonth(), bj.getUTCDate() + off));
    const r = mk(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    const lbl = ['今天', '昨天', '前天'][-off];
    return { label: lbl + '（' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日）', ...r };
  }
  return null;
}

async function sayRaw(q) {
  if (!RAW_ASK.test(q)) return '';
  const dm = /(\d+)\s*天/.exec(q);
  const days = Math.min(7, Math.max(1, Number(dm && dm[1]) || 3));
  /* 🔴 「今天说话了吗」这种要**先给结论**：默认落到今天，别退回「最近 3 天」 */
  const dr = bjDayRange(q) || (dm ? null : bjDayRange('今天'));
  const u = new URL(WORKER + '/api/mem');
  u.searchParams.set('k', KEY);
  u.searchParams.set('q', q);
  u.searchParams.set('days', String(days));
  u.searchParams.set('sayMax', '40');
  if (dr) {
    u.searchParams.set('from', String(dr.from));
    u.searchParams.set('to', String(dr.to));
  }
  const d = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json().catch(() => null);
  if (!d || !d.ok) return '';
  const who = d.name || '她';
  const span = dr ? dr.label : '最近' + days + '天';
  if (!Array.isArray(d.sayAll) || !d.sayAll.length) {
    if (!dr) return '';
    return `【${who}·${span}】没在口袋房间说话（这一天空着）`;
  }
  const L = ['【' + who + '·' + span + '房间发言原话】共 ' + d.sayAll.length + ' 条'];
  for (const x of d.sayAll) {
    const s = String((x && x.s) || x || '');
    if (!s) continue;
    if (L.join('\n').length + s.length + 3 > 1700) { L.push('…（后面还有，缩短天数再问）'); break; }
    L.push('· ' + s);
  }
  return L.join('\n');
}

async function askAI(chat, q) {
  const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const qk = chat + ':' + ymd;
  const used = aiQuota.get(qk) || 0;
  if (used >= AI_DAILY) return '今天这个群的 AI 次数用完了，明天再来吧。';

  /* 🔴 榜单数据**只在问数据时才注入**（2026-11-12：群友逗「你要叫她王子殿下」，
     模型却答「本小48只认红蓝榜上的名字」—— 把榜单塞进系统提示，它就会往榜上靠）。
     纯闲聊不带榜单，它才肯好好接梗。 */
  const needBoard = /榜|排名|第一|前几|多少|几[分个]|鸡腿|红蓝|top|数据/i.test(q);
  /* 🔴 **别再靠正则猜语序**（2026-11-12 教训：站长问「最近五分钟说话的成员」，正则只认
     「谁在说话」那一种语序 → 整句掉进 AI，模型凭空报了「小草莓、小番茄、小西瓜、小芒果」）。
     现在每条 @ 都并行把实时名单塞进 system，**问不问由模型自己判断** —— 只是多读两次 KV。
     🔴 必须给**两档**（5 分钟 + 30 分钟）：只给 30 分钟那档，模型会把半小时的人当成「最近五分钟」。 */
  const [ctx, mem, who5, who30] = await Promise.all([
    needBoard ? boardCtx() : Promise.resolve(''),
    memCtx(q),
    whoCtx(5),
    whoCtx(30),
  ]);
  /* 名单取不到时给硬约束，否则模型会自己编一桌人 */
  const who = [who5, who30].filter(Boolean).join('\n') ||
    '【实时·取数失败】这次没拿到实时名单。🔴 直接说「实时名单我这次没取到，再问我一次」，'
    + '绝对不许报任何名字（编名字比说取不到更糟）。';
  /* 🔴 命中成员资料时历史只留 2 条。群里常连着问好几个人，8 条历史里全是对别人的描述，
     模型会把 A 的原话安到 B 头上（2026-11-12 实测：问陈淑钰，答成王语晨的话）。 */
  const hist = (aiHist.get(chat) || []).slice(-(mem ? 2 : 8));
  const messages = [
    /* 🔴 云端下发的全部指令也塞进来：被问「你都会啥/有哪些指令」时，模型照抄即可，
       云端新加了指令它自然就知道（不用再改代码里的 AI_SYS）。 */
    { role: 'system', content: [AI_SYS, usageAll() ? '【你会这些指令】\n' + usageAll() : '', learnCtx(chat), who, ctx, mem].filter(Boolean).join('\n\n') },
    ...hist,
    { role: 'user', content: q },
  ];

  if (AI_VIA_WORKER) {
    const res = await fetch(WORKER + '/api/ai?k=' + encodeURIComponent(KEY), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q, sys: messages[0].content, hist }),
      signal: AbortSignal.timeout(45000),
    });
    const d = await res.json().catch(() => null);
    if (!d || !d.ok || !d.reply) {
      throw new Error('AI ' + (res.status) + ' ' + String((d && (d.e || d.msg)) || ''));
    }
    aiQuota.set(qk, used + 1);
    const next = [...hist, { role: 'user', content: q }, { role: 'assistant', content: d.reply }].slice(-8);
    aiHist.set(chat, next);
    learnFrom(chat, q, String(d.reply)).catch(() => {});   // 后台提炼，不拖慢回复
    return String(d.reply).slice(0, 1200);
  }

  const res = await fetch(AI_BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AI_KEY },
    body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.7, max_tokens: 400 }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) throw new Error('AI ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const d = await res.json();
  const out = String((((d.choices || [])[0] || {}).message || {}).content || '').trim();
  if (!out) throw new Error('AI 空回复');

  aiQuota.set(qk, used + 1);
  const next = [...hist, { role: 'user', content: q }, { role: 'assistant', content: out }].slice(-8);
  aiHist.set(chat, next);
  learnFrom(chat, q, out).catch(() => {});
  return out.slice(0, 1200);
}

/* ---------------- 工具决策：让模型听懂人话，但数据永远由桥去取 ----------------
   站长 2026-11-13：「AI 它其实不是指令，是一个自然语言」。
   做法：模型只输出**一行 JSON**（选哪个工具 + 参数），执行在本地、数据来自接口，
   所以模型没有任何编数据的空间；它判断「不用查」时自己写一句 reply。
   🔴 规则（naturalCmd）仍排在最前面：认得出的问法 0 次模型调用，只有认不出的才走到这里。
     两边都留着不是冗余 —— 规则是毫秒级、免费、结果稳定，模型负责覆盖长尾说法。 */

const TOOL_DOC = [
  '【可用工具】只能选一个。参数必须是真实的名字/队名，拿不准就留空。',
  'who   最近几分钟谁在说话      {"team":"NIII","min":30}   team 可省，min 默认 5',
  'when  某天/某时段谁在说话     {"team":"G","day":"昨天","hour":11}   hour 省=整天',
  'say   某成员说过什么原话      {"name":"林舒晴","days":3}   也可加 "day":"昨天"',
  'lg    鸡腿（房间+直播）       {"target":"林舒晴"}   target 可为队名/团名/空',
  'gy    公演鸡腿                {"target":"niii","range":"近7天"}',
  'rb    红蓝分                  {"target":"niii"}   也可 "group"（全团）/"top64"',
  'mvp   年度之星                {"target":"top20"}  或成员名',
  'none  不需要查数据           必须同时给 reply',
  'analyze  要解释原因/对比/趋势/评价（不是单纯查一个数）  {"focus":"niii 这周鸡腿为什么掉"}',
].join('\n');

const PLAN_RULES = [
  '【怎么回】',
  '1. 需要真实数据（谁在说话/某人说了什么/鸡腿/红蓝/公演/年度之星/排名）→ 只输出工具 JSON，不要自己写答案。',
  '1b. 单纯要一个数/一个榜 → 用上面的具体工具（快、准）；要**解释原因、对比两队、看趋势、下判断** → 用 analyze。',
  '2. 不需要数据（闲聊、玩梗、问规则、让你改口叫外号）→ {"tool":"none","reply":"你的回复"}'
  + '（reply ≤80字，**必须写，不能空**）',
  '3. 🔴 只能输出**一行 JSON**，必须以 {\"tool\" 开头；不要 ``` 围栏、不要解释、不要换行。',
  '4. 🔴 参数一律放在 args 里，不要写 action/param/target 之类的变体。',
  '5. 🔴 绝对不许把分数/名单/原话写进 JSON —— 那些由工具去查，你写了就是编。',
  '例：{"tool":"who","args":{"team":"NIII","min":5}}',
  '例：{"tool":"say","args":{"name":"林舒晴","days":3}}',
  '例：{"tool":"none","reply":"叫小48，随时问我就好"}',
].join('\n');

/* 云端下发的「全部指令」说明。🔴 一处来源两处用：
   ① 群里发 `?` / 「指令」直接贴出去；② 塞进 AI 的 system —— 否则模型被问
   「你都会啥」只能靠 AI_SYS 里那几句写死的，云端新加的指令它根本不知道。 */
function usageAll() {
  return String(SPEC.usage._all || '').trim();
}

const planSys = () => AI_SYS + '\n\n'
  + (usageAll() ? '【你现在会这些指令，被问到就照这个说】\n' + usageAll() + '\n\n' : '')
  + TOOL_DOC + '\n\n' + PLAN_RULES;

/* 🔴 模型输出的键名完全不受控（实测三种：args / param / 参数直接摆顶层；
   tool 有时写成 action，或者干脆不写只给 {"team":"niii","min":5}）。
   与其在提示词上较劲，不如在这里统一归一化 —— 提示词约束 + 结果兜底两手都要。 */
const PLAN_ARGS_KEYS = ['team', 'min', 'day', 'hour', 'name', 'days', 'target', 'range'];
function planNorm(p) {
  if (!p || typeof p !== 'object') return null;
  const pick = [p.args, p.param, p.params].find((x) => x && typeof x === 'object' && !Array.isArray(x));
  const args = pick ? { ...pick } : {};
  /* 顶层散落的参数搬进来（{"tool":"lg","target":"林舒晴"} 这种） */
  for (const k of PLAN_ARGS_KEYS) if (args[k] === undefined && p[k] !== undefined) args[k] = p[k];
  let tool = String(p.tool || p.name_tool || p.action || p.fn || '').toLowerCase();
  /* 漏了 tool 键时只推测最稳的两种，其余当没用（猜错工具比不回答更糟） */
  if (!tool) {
    if (args.team || args.min) tool = 'who';
    else if (args.name) tool = 'say';
  }
  return { tool, args };
}

/** 从模型输出里剥出那个 JSON 对象（模型爱带 ```json 围栏、前后废话，qwen 还会先念一段思考）。
 *  🔴 不能用非贪婪正则：`{"tool":"who","args":{"team":"NIII"}}` 里有嵌套，必须配平括号。 */
function planJson(t) {
  const s = String(t || '').replace(/```[a-zA-Z]*\s*/g, '');
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let d = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') d++;
      else if (s[j] === '}') {
        d--;
        if (!d) {
          try {
            const o = JSON.parse(s.slice(i, j + 1));
            if (o && typeof o === 'object' && !Array.isArray(o)) found.push(o);
          } catch { /* 这一段不是合法 JSON，往后找 */ }
          break;
        }
      }
    }
  }
  /* 优先带 tool 的那个；模型漏了 tool 只给参数时，取第一个（planNorm 兜底推断） */
  return found.find((o) => 'tool' in o) || found[0] || null;
}

/** 让模型做一次「调哪个工具」的决策。失败返回 null（调用方降级到普通聊天）。 */
async function aiPlan(q, chat) {
  if (!AI_ON) return null;
  const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const qk = chat + ':' + ymd;
  if ((aiQuota.get(qk) || 0) >= AI_DAILY) return null;

  let out = '';
  /* 🔴 qwen3 默认先写一大段「思考」，把 max_tokens 吃光后 content 就是空的
     （实测「今晚公演鸡腿谁最高」直接 blank，10 秒白等）。`/no_think` 是 Qwen3 官方的关思考开关，
     实测耗时从 3.8s 降到 0.5s，且 JSON 更规矩。 */
  const ask = q + '\n/no_think';
  try {
    if (AI_VIA_WORKER) {
      const res = await fetch(WORKER + '/api/ai?k=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        /* 只带 system + 这一句：决策不需要历史（历史里有别人的名字，容易被带跑） */
        body: JSON.stringify({ q: ask, sys: planSys(), hist: [], mt: 400 }),
        signal: AbortSignal.timeout(25000),
      });
      const d = await res.json().catch(() => null);
      if (!d || !d.ok) return null;
      out = String(d.reply || '');
    } else {
      const res = await fetch(AI_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AI_KEY },
        body: JSON.stringify({
          model: AI_MODEL, temperature: 0.2, max_tokens: 400,
          messages: [{ role: 'system', content: planSys() }, { role: 'user', content: ask }],
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) return null;
      const d = await res.json();
      out = String((((d.choices || [])[0] || {}).message || {}).content || '');
    }
  } catch (e) {
    log('plan 失败：' + String((e && e.message) || e).slice(0, 80));
    return null;
  }
  if (!out.trim()) return null;
  aiQuota.set(qk, (aiQuota.get(qk) || 0) + 1);
  const raw = planJson(out);
  if (!raw) { log('plan 不是 JSON：' + out.replace(/\s+/g, ' ').slice(0, 80)); return null; }
  const p = planNorm(raw) || raw;
  /* 🔴 参数必须**来自用户这句话**。实测模型会顺着语气脑补：问「今晚公演鸡腿谁最高」
     它给 team=niii（全团的问题被缩成 NIII 队，数字直接错）。宁可清空参数走全团，
     也不能让它凭空指定对象。 */
  return planGuard(p, q);
}

/** 把模型给的参数和原句对一遍，原句里没有的一律丢掉（纯函数，方便回归） */
function planGuard(p, q) {
  if (!p || !p.args) return p;
  const lowq = String(q || '').toLowerCase();
  for (const k of ['team', 'name', 'target']) {
    const v = String(p.args[k] || '').trim();
    if (!v) continue;
    const lit = /^(全团|全员|全体|全站|全团榜|group|top\d+)$/i.test(v);
    if (!lit && !lowq.includes(v.toLowerCase())) {
      log(`plan 参数不在原句里，丢弃：${k}=${v}（原句：${String(q).slice(0, 24)}）`);
      delete p.args[k];
    }
  }
  return p;
}

/* 队名白名单：模型可能吐「NIII队」「niii 」这种，清洗后再决定用不用 */
const TEAM_OK = /^(SNH|GNZ|BEJ|CGT|CKG|NIII|NII|GII|SII|HII|CII|KII|XII|G|Z|X|C|K|B|E|预备生|IDFT|广州联合|川渝联合)$/;

/** 执行模型选的工具，返回可直接发群的文案（空字符串 = 没查到/不能执行） */
async function runTool(p) {
  const t = String((p && p.tool) || '').toLowerCase();
  const a = (p && p.args && typeof p.args === 'object') ? p.args : {};
  let team = String(a.team || '').toUpperCase().replace(/队$/, '').trim().slice(0, 12);
  if (team && !TEAM_OK.test(team)) team = '';
  const min = Math.min(720, Math.max(1, Number(a.min) || 5));
  const dayStr = String(a.day || '');
  const dayOff = /前天/.test(dayStr) ? -2 : (/昨天|昨日/.test(dayStr) ? -1 : 0);

  if (t === 'who') return whoReply(min, team);

  if (t === 'when') {
    const h = Number(a.hour);
    if (isFinite(h) && h >= 0 && h <= 23) return whenReply({ team, dayOff, h, end: h + 1, half: false });
    return whenReply({ team, dayOff, wholeDay: true });
  }

  if (t === 'say') {
    const name = String(a.name || '').trim().slice(0, 30);
    if (!name) return '';
    const days = Math.min(7, Math.max(1, Number(a.days) || 3));
    /* 拼成 sayRaw 认得的说法：它靠 RAW_ASK（发言/原话）当闸门，靠 bjDayRange 认「昨天」 */
    const q = name + ' ' + (dayStr ? dayStr.slice(0, 8) + ' ' : '最近' + days + '天 ') + '的发言原话';
    const txt = await sayRaw(q);
    return txt || '';
  }

  if (t === 'lg' || t === 'rb' || t === 'mvp' || t === 'gy') {
    const target = String(a.target || a.name || '').trim().slice(0, 40);
    /* 「今晚/昨晚」这种口语 lv 那边不认，先归成它能解析的写法 */
    const rg = String(a.range || '').replace(/今晚|今早/g, '今天').replace(/昨晚|昨早/g, '昨天').trim();
    let q;
    if (t === 'gy') q = 'gy?' + target + (rg ? ' ' + rg.slice(0, 20) : '');
    else q = t + '?' + (target || ' ');
    const u = new URL(WORKER + '/api/cmd');
    u.searchParams.set('k', KEY);
    u.searchParams.set('q', q);
    const r = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json().catch(() => null);
    return (r && r.ok && r.reply) ? String(r.reply).slice(0, 1800) : '';
  }
  return '';
}

/* ---------------- 「这条指令怎么用」 ----------------
   2026-11-13 实测：站长发 `gy 查询指令`，被当成 `gy?查询指令` → 去名册里找「查询指令」这个人
   → 回「名册里没找到「查询指令」」。任何前缀后面跟「用法/指令/怎么用/help」都应该回说明。
   🔴 文案由云端下发（KV `wxcmd:spec` 的 usage 字段），桥里**不留**任何一条指令的说明文字，
      否则改文案又要发版、又出现「本地云端两份」。没配就只说「发『指令』看全部」。 */
function usageFor(c, plain) {
  /* 「有哪些指令 / 全部命令 / gy 用法 / 怎么用」都要认 —— 但必须**整句等于**这些说法，
     「这个用法不错」这种闲聊不能触发（2026-11-13 群里实测过一堆口径）。 */
  const HELP = new RegExp([
    '^(?:查询|查看|看一下)?(?:指令|用法|说明|帮助|怎么用|怎么查|怎么看|help|menu)$',
    '^(?:有|都有|能|会)?(?:哪些|什么|几个)?(?:指令|命令|功能|用法)(?:吗|呢|呀)?$',
    '^(?:全部|所有|全部指令|所有指令|全部命令|全都能查)$',
    '^[?？]$',
  ].join('|'), 'i');
  let key = '';
  let rest = '';
  if (c) {
    if (c.kind === 'raw') {
      /* raw 的 name 是整句，先认出命中哪个前缀，剩下的才算「问的是用法」 */
      const s = String(c.name || '');
      const p = SPEC.prefixes.map((x) => String(x))
        .sort((a, b) => b.length - a.length)
        .find((x) => x && s.toLowerCase().startsWith(x.toLowerCase()));
      if (p) { key = p.toLowerCase(); rest = s.slice(p.length); }
      else rest = s;
    } else {
      key = String(c.kind || '').toLowerCase();
      rest = String(c.name || '');
    }
    rest = rest.replace(/^[\s?？:：,，.。、!！]+/, '').trim();
  } else {
    rest = String(plain || '').trim();
  }
  if (!HELP.test(rest)) {
    /* 单独一个「?」= 看全部指令（站长 2026-11-13）。`gy?` 这种带前缀的不算 —— 那是查全团。 */
    if (rest === '?' || rest === '？') {
      if (c && c.kind === 'raw') return '';
      return SPEC.usage._all || '这条我还不知道咋用～直接发「指令」看我能查什么';
    }
    return '';
  }
  return SPEC.usage[key] || SPEC.usage._all || '这条我还不知道咋用～直接发「指令」看我能查什么';
}

/* ---------------- 分析层：把全站真实数据喂给模型，让它自己判断 ----------------
   站长 2026-11-13：「我需要 AI 是智能的 —— 把补档站所有的内容给到它，跟它聊的时候它能
   识别我的意图、给一定的分析。虽然消耗 token，但这个有价值。能用指令查到的时候就不要
   token，查不到的时候它自己去分析。」
   于是三层分工：
     ① 显式指令 / 规则认得出 → 直接查（0 次模型调用，毫秒级）
     ② 要判断、解释、对比、趋势、预测 → 这里（喂**真实数据快照**，1 次模型调用）
     ③ 纯闲聊 → askAI
   🔴 模型只能看事实包，事实包里没有的数字它一个字都不许说。 */

/* 什么算「要分析」：解释原因、比较、趋势、评价、预测。🔴 别把「多少/谁/第几」这类
   纯查询的词放进来 —— 那些走规则更快更准，白花 token。 */
const ANALYZE_Q = new RegExp([
  '为什么|为啥|咋回事|怎么回事|怎么会',
  '分析|对比|比较|趋势|走势|变化|起伏',
  '进步|退步|下滑|掉了|跌了|涨了|拉开|追上|反超',
  '表现|评价|点评|总结|盘点|格局|实力|潜力|竞争力',
  '谁更|哪队|哪个队|哪个团|会不会|预测|值得|建议|该怎么|怎么看|怎么样|如何',
].join('|'));

const FACTS_TTL = 4 * 60 * 1000;
let factsCache = { at: 0, text: '' };

/** 带 k 的 GET（失败一律 null，缺块就少一块，绝不因为一块挂了整个分析失败） */
async function apiJson(path, ms = 9000) {
  try {
    const u = new URL(WORKER + path);
    u.searchParams.set('k', KEY);
    const r = await fetch(u, { signal: AbortSignal.timeout(ms) });
    return await r.json().catch(() => null);
  } catch { return null; }
}

/** 全站快照（与问题无关的公共部分，缓存 4 分钟 —— 一次分析要拉 5 个接口，
 *  群里连问三句不该重复拉）。*/
async function factsBase() {
  if (factsCache.text && Date.now() - factsCache.at < FACTS_TTL) return factsCache.text;
  const [gift, lg, gy, mvp, who, live] = await Promise.all([
    apiJson('/api/gift?limit=15', 15000),      // 红蓝累计（团/队/成员）
    /* 全团鸡腿 + **逐日序列 + 上周**（2026-11-13 新增）：没有序列就只能说「没数据」，
       「为什么这周掉」「哪个队涨得最快」这类问题全靠它。 */
    apiJson('/api/cmd?q=' + encodeURIComponent('lg?'), 15000),
    apiJson('/api/cmd?q=' + encodeURIComponent('gy?'), 15000),   // 公演鸡腿近7天
    apiJson('/api/cmd?q=' + encodeURIComponent('mvp?top20'), 9000), // 年度之星
    apiJson('/api/who?min=60&n=12', 9000),     // 近1小时房间活跃
    apiJson('/api/live', 9000),                // 此刻在播
  ]);
  const L = ['【本站真实数据·快照 ' + bjHM(Date.now()) + '】'];

  if (gift && Array.isArray(gift.rank) && gift.rank.length) {
    L.push(`■ 红蓝歌会（${gift.from}~${gift.to}，${gift.daysCount || '?'} 天，累计 ${fmtNum(gift.total)} 分，${gift.records || '?'} 笔礼物）`);
    const gs = (gift.groups || []).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
      .map((x) => `${x.key} ${fmtNum(x.score)}（${x.members}人）`).join(' · ');
    if (gs) L.push('　团：' + gs);
    /* 🔴 各团的「预备生」是不同的人，光写「预备生」会出现四行同名 ⇒ 带上团名 */
    const ts = (gift.teams || []).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)
      .slice(0, 10).map((x) => `${String(x.g || '').replace(/48$/, '')}`
        + `·${String(x.tm || '').replace(/^TEAM\s*/i, '')} ${fmtNum(x.score)}`).join(' · ');
    if (ts) L.push('　队：' + ts);
    const rk = gift.rank.slice(0, 15).map((x, i) => `${i + 1}.${x.name} ${fmtNum(x.score)}`
      + (x.team ? '(' + String(x.team).replace(/^TEAM\s*/i, '') + ')' : '')).join(' · ');
    L.push('　成员前15：' + rk);
  }

  /* 全团鸡腿（房间+直播）：今日 / 近7天 / 上周 + 逐日 + 队 + 成员前 15。
     🔴 只有机读字段（series/teams/top）才可信，别去解析 reply 的排版。 */
  if (lg && lg.ok && Array.isArray(lg.series)) {
    const wk = Number(lg.week) || 0, pv = Number(lg.prev) || 0;
    const pct = pv > 0 ? ((wk - pv) / pv) * 100 : 0;
    const wow = pv > 0 ? `，上周 ${fmtNum(pv)}（环比 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）` : '';
    L.push(`■ 全站鸡腿（房间+直播，不含公演）：今日 ${fmtNum(lg.today)}，近7天 ${fmtNum(wk)}${wow}`);
    const day = (lg.series || []).slice(-7)
      .map((x) => `${String(x.d).slice(4, 6)}-${String(x.d).slice(6, 8)} ${fmtNum(x.v)}`).join(' · ');
    if (day) L.push('　全站逐日 ' + day);
    const ts = (lg.teams || []).filter((x) => x.w > 0).slice(0, 10)
      .map((x) => {
        const w = Number(x.w) || 0, p = Number(x.prev) || 0;
        const pc = p > 0 ? ` ${((w - p) / p) * 100 >= 0 ? '+' : ''}${(((w - p) / p) * 100).toFixed(0)}%` : '';
        return `${String(x.g || '').replace(/48$/, '')}·${String(x.k || '').replace(/^TEAM\s*/i, '')}`
          + ` ${fmtNum(w)}${pc}`;
      })
      .join(' · ');
    if (ts) L.push('　队（近7天，括号内为环比）：' + ts);
    const tp = (lg.top || []).slice(0, 15)
      .map((x, i) => `${i + 1}.${x.n} ${fmtNum(x.w)}`)
      .join(' · ');
    if (tp) L.push('　成员前15（近7天）：' + tp);
  }

  if (gy && gy.ok && gy.reply) {
    const ln = String(gy.reply).split('\n').filter((x) => x.trim());
    if (ln[0]) L.push('■ 公演鸡腿｜' + ln[0].replace(/^【([^】]*)】\s*/, '$1｜').replace(/^公演[·•]\s*/, ''));
    if (ln[1] && /^共/.test(ln[1])) L.push('　' + ln[1]);
    const rows = ln.filter((x) => /^\d+\./.test(x)).slice(0, 12).map((x) => x.replace(/^(\d+)\.\s*/, '$1.'));
    if (rows.length) L.push('　' + rows.join(' · '));
  }

  if (mvp && mvp.ok && mvp.reply) {
    const ln = String(mvp.reply).split('\n').filter((x) => x.trim());
    if (ln[0]) L.push('■ 年度之星｜' + ln[0].replace(/^【([^】]*)】\s*/, '$1｜'));
    const rows = ln.filter((x) => /^\d+\./.test(x)).slice(0, 10).map((x) => x.replace(/^(\d+)\.\s*/, '$1.'));
    if (rows.length) L.push('　' + rows.join(' · '));
  }

  if (live && Array.isArray(live.list) && live.list.length) {
    const s = live.list.slice(0, 6).map((x) => `${String(x.nickname || '').replace(/^[A-Z]{3,4}48-/, '')}`
      + `「${String(x.title || '').slice(0, 18)}」${fmtNum(x.onlineUserNum)}人在看`);
    L.push(`■ 此刻在播（${live.list.length} 间）：` + s.join(' · '));
  } else if (live) {
    L.push('■ 此刻没有成员在播');
  }

  if (who && who.ok && Array.isArray(who.list) && who.list.length) {
    /* 🔴 接口是按时间倒序给的，问「最活跃」必须自己按条数排 */
    const s = who.list.slice().sort((a, b) => (b.c || 0) - (a.c || 0)).slice(0, 8)
      .map((x) => `${x.n}(${String(x.tm || x.g || '').replace(/^TEAM\s*/i, '')})${x.c}条`);
    L.push(`■ 近 60 分钟口袋房间：${who.total} 人发言 ${who.msgN || 0} 条，最活跃 ` + s.join(' · '));
    const q = who.list.find((x) => x.x);
    if (q) L.push(`　样本原话：${q.n}「${String(q.x).slice(0, 40)}」`);
  }

  const text = L.join('\n');
  if (L.length > 1) factsCache = { at: Date.now(), text };
  return text;
}

/** 某一支队自己的鸡腿曲线（今日 / 近7天 / 上周 / 逐日 / 队内前5）。
 *  🔴 全团块给的是**全站**逐日，拿它去解释某支队为什么会得出错误结论
 *  （实测模型把全站的 11-11 峰值当成 NIII 的，说「NIII 从 956 万掉到 470 万」）。 */
async function teamFacts(team) {
  const j = await apiJson('/api/cmd?q=' + encodeURIComponent('lg?' + team), 15000);
  if (!j || !j.ok || !Array.isArray(j.series)) return '';
  const wk = Number(j.week) || 0, pv = Number(j.prev) || 0;
  const pct = pv > 0 ? ((wk - pv) / pv) * 100 : 0;
  const wow = pv > 0 ? `，上周 ${fmtNum(pv)}（环比 ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%）` : '';
  const L = [`■ ${j.team || team} 鸡腿（房间+直播）：今日 ${fmtNum(j.today)}，近7天 ${fmtNum(wk)}${wow}`];
  const day = (j.series || []).slice(-7)
    .map((x) => `${String(x.d).slice(4, 6)}-${String(x.d).slice(6, 8)} ${fmtNum(x.v)}`).join(' · ');
  if (day) L.push('　逐日 ' + day);
  const tp = (j.top || []).slice(0, 5).map((x, i) => `${i + 1}.${x.n} ${fmtNum(x.w)}`).join(' · ');
  if (tp) L.push('　队内前5（近7天）：' + tp);
  return L.join('\n');
}

/** 事实包 = 全站快照 + 点名成员的资料 + 点名队伍的曲线 + 规则已查到的那条数据 */
async function factsPack(q, extra) {
  let team = '';
  try { team = q ? teamOf(q) : ''; } catch { team = ''; }
  const [base, mem, tm] = await Promise.all([
    factsBase().catch(() => ''),
    q ? memCtx(q).catch(() => '') : Promise.resolve(''),
    team ? teamFacts(team).catch(() => '') : Promise.resolve(''),
  ]);
  return [base, mem, tm, extra].filter(Boolean).join('\n\n');
}

const ANALYZE_SYS = [
  '你是「弦月回响·红蓝歌会」粉丝群里的助手小48，现在在帮群友**看数据**。',
  '下面会给你一份本站真实数据快照。请基于它回答，像熟悉48的老粉那样分析，不要像报表。',
  '怎么写：',
  '1. 第一句先给结论（谁/哪队/为什么），后面最多 3 条依据，每条带具体数字。',
  '2. 总长 ≤220 字，最多 7 行；要分点就用「·」，不要 markdown 标题、表格、加粗。',
  '3. 🔴 只能用快照里出现过的名字和数字。快照里没有的，就说「这个数据我这边没有」，绝不编。',
  '4. 🔴 不要把快照原样抄一遍 —— 群友要的是判断，不是又看一次榜。',
  '5. 🔴 三套数据不能混：红蓝是「红蓝分」、公演是「公演鸡腿」、房间/直播是「鸡腿」；'
  + '没给到的那套就说没拿到，别拿另一套顶。',
  '6. 🔴 分块看口径：「鸡腿」那块有 **7 天逐日 + 上周合计**，可以判断涨跌、找拐点、比哪个队最快；'
  + '「红蓝」是 10-24 起累计、「公演」是近 7 天合计，这两块**没有逐日**，只能比大小、不能判趋势。',
  '7. 🔴 被问「为什么掉」：先用逐日指出哪一天掉得最狠、掉了多少，再只根据快照里真有的东西'
  + '（谁在播、谁在说话、有没有公演）给可能解释，最后一句说明「因果我这看不到」。'
  + '不许把巧合说成原因。🔴 也先看清到底是不是在掉：环比是正数就是涨了，别顺着问句认下来。',
  '8. 🔴 报数前后自己核一遍：A 比 B 大就不能写「低于」。全站数字不能当成某支队的数字用。',
  '9. 🔴 不要罗列「未提及/没有数据/未见」这种空话，一句话说清能说什么就行。',
  '10. 快照里的发言是过去时，不要写成「正在说」。',
].join('\n');

/** 让模型做一次分析。失败返回空串（调用方降级到普通聊天）。 */
async function askAnalyze(chat, q, facts) {
  if (!AI_ON) return '';
  const ymd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const qk = chat + ':' + ymd;
  const used = aiQuota.get(qk) || 0;
  if (used >= AI_DAILY) return '今天这个群的 AI 次数用完了，明天再来吧。';
  const sys = ANALYZE_SYS + '\n\n' + (usageAll() ? '【你会这些指令】\n' + usageAll() + '\n\n' : '') + facts;
  try {
    if (AI_VIA_WORKER) {
      const res = await fetch(WORKER + '/api/ai?k=' + encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, sys, hist: [], mt: 700 }),
        signal: AbortSignal.timeout(45000),
      });
      const d = await res.json().catch(() => null);
      if (!d || !d.ok || !d.reply) return '';
      aiQuota.set(qk, used + 1);
      /* 分析带上下文：下一句「那她这周呢」要接得上 */
      aiHist.set(chat, [...(aiHist.get(chat) || []), { role: 'user', content: q },
        { role: 'assistant', content: String(d.reply) }].slice(-8));
      return String(d.reply).slice(0, 1200);
    }
    const res = await fetch(AI_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + AI_KEY },
      body: JSON.stringify({
        model: AI_MODEL, temperature: 0.4, max_tokens: 700,
        messages: [{ role: 'system', content: sys }, { role: 'user', content: q }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) return '';
    const d = await res.json();
    const out = String((((d.choices || [])[0] || {}).message || {}).content || '').trim();
    if (!out) return '';
    aiQuota.set(qk, used + 1);
    aiHist.set(chat, [...(aiHist.get(chat) || []), { role: 'user', content: q },
      { role: 'assistant', content: out }].slice(-8));
    return out.slice(0, 1200);
  } catch (e) {
    log('分析失败：' + String((e && e.message) || e).slice(0, 80));
    return '';
  }
}

/* ---------------- 处理一条 ---------------- */

const oddDir = new Set();
async function handle(ev) {
  const d = ev.data || {};
  if (d.direction !== 'incoming') {
    /* 字段名/取值和预期不一致时，以前是静默 return —— 「收到事件却全丢」就查不出来 */
    const k = String(d.direction);
    if (!oddDir.has(k)) { oddDir.add(k); log('忽略方向：' + (k === 'undefined' ? '（事件里没有 direction）' : k)); }
    return;
  }
  const chat = String(d.threadId || '');
  if (!chat.endsWith('@chatroom')) return;                    // 只做群，私聊不接（免得小号私聊被刷）
  if (GROUPS.length && !GROUPS.includes(chat)) return;
  if (seen(String(d.messageId))) return;

  /* 每条都留一行（很短）：机器人「活着但不说话」时，这一行能立刻分辨是
     「没收到事件」还是「收到了没认出来」——过去全靠猜，浪费了一整晚。 */
  log(`收 ${chat.slice(0, 8)} ${String(d.senderName || d.fromName || '').slice(0, 10)}: ${String(d.text || d.body || '').replace(/\s+/g, ' ').slice(0, 30)}`);

  /* 🔴 `messages get` 会偶发超时（2026-11-12 22:49 实测「处理异常：wx 超时」，
     那条指令就这么静默丢了）。重试一次；还失败就用事件自带字段兜底 —— 事件里
     一般就有 body/type，缺的只是 mentions，宁可漏判 @ 也别整条吞掉。 */
  let m = null;
  for (let i = 1; i <= 2 && !m; i++) {
    try {
      const j = jsonOf(await wx(['--account', ACCOUNT, '--json', 'messages', 'get', String(d.messageId)], 20000));
      m = (j && (j.message || j)) || null;
    } catch (e) {
      log(`messages get 失败（${i}/2）：${String((e && e.message) || e).slice(0, 100)}`);
      if (i < 2) await sleep(800);
    }
  }
  if (!m) {
    const fb = String(d.text || d.body || '').trim();
    if (!fb) { log('消息取不到内容，跳过：' + String(d.messageId || '').slice(-12)); return; }
    m = { type: d.type === undefined ? 1 : d.type, body: fb, mentions: d.mentions || {}, createTime: d.createTime };
    log('用事件自带内容兜底解析：' + fb.slice(0, 30));
  }
  /* 🔴 历史消息一律不回复（新机器首启 / 游标丢失时会重放） */
  if (Date.now() < SILENT_UNTIL) return;
  const mt = msgTimeMs(m);
  if (mt && mt < START_AT - 120000) return;
  if (Number(m.type) !== 1) return;                           // 只要纯文本，图片/引用/文件一概略过

  const men = m.mentions || {};
  if (REQUIRE_MENTION && !men.self && !men.all) return;

  /* 单独一个「?」= 看全部指令。🔴 必须 @ 我 —— 群里随便谁打个问号不该刷一屏。 */
  const body0 = String(m.body || '');
  const plain0 = (body0.replace(/^@[^\s\u2005]+[\s\u2005]+/, '') || body0).trim();
  if (/^[?？]$/.test(plain0) && !(men.self || men.all)) return;

  const body = String(m.body || '');
  /* 手打 `@boooot lg?bej` 也要认：微信没给 atuserlist 时正文里就带着 @名字，剥掉再解析一次 */
  const stripped = body.replace(/^@[^\s\u2005]+[\s\u2005]+/, '');
  const plain = stripped || body;
  let c = cmdOf(body) || (stripped !== body ? cmdOf(stripped) : null);
  /* 云端登记的新指令前缀（KV wxcmd:spec）——命中就把原文整句转给 worker 解析 */
  if (!c) c = cloudCmd(plain);

  /* 🔴 本群专属后缀：必须排在 AI / 自然语言之前 —— 否则「回复后缀要加上 X」
     会被当成闲聊，模型只回一句玩笑话、什么都没存（2026-11-14 站长就是撞在这个上）。 */
  if (!c) {
    const sr = suffixSet(chat, plain0);
    if (sr) { await say(chat, sr, '[后缀]'); return; }
  }

  /* ② 需要判断/解释/对比/趋势 → 分析层（喂真实数据快照，1 次模型调用）
     🔴 排在规则之前：`NIII这周鸡腿怎么掉这么多` 这种句子规则只会回一个榜，
        群友要的是「为什么」。真正的纯查询（多少/谁/第几）不含这些词，仍旧走规则。
     显式指令（lg?/gy?/fy? 等）已经在前面命中，不会被这里抢走。 */
  if (!c && ANALYZE_Q.test(plain)) {
    try {
      /* 先把规则认得出的那条数据也查出来一起喂（问「NIII 为什么掉了」，没有 NIII 的榜就没法答） */
      let extra = '';
      try {
        const r0 = await naturalCmd(plain);
        if (r0 && /^(lg|gy|rb|mvp)$/.test(String(r0.kind))) {
          const u0 = new URL(WORKER + '/api/cmd');
          u0.searchParams.set('k', KEY);
          u0.searchParams.set('q', r0.kind + '?' + (r0.name || ' '));
          const d0 = await (await fetch(u0, { signal: AbortSignal.timeout(15000) })).json().catch(() => null);
          if (d0 && d0.ok && d0.reply) extra = '【规则查到的原始数据】\n' + String(d0.reply).slice(0, 900);
        }
      } catch { /* 查不到就不带，分析仍然可用 */ }
      const facts = await factsPack(plain, extra);
      const txt = await askAnalyze(chat, plain, facts);
      if (txt) { await say(chat, txt, '[分析] ' + plain.slice(0, 16)); return; }
    } catch (e) { log('分析没成：' + ((e && e.message) || e).toString().slice(0, 80)); }
    /* 分析失败就继续往下走常规路径，不能让一条问句没回音 */
  }

  /* 自然语言查询（「帮我查陈淑钰的鸡腿」）—— 必须先于 AI，否则模型拿红蓝分冒充鸡腿 */
  if (!c) { try { c = await naturalCmd(plain); } catch { c = null; } }

  /* 「XX 查询指令 / 用法 / 怎么用」→ 贴云端下发的说明（这条要排在 fy 展开之前）。
     🔴 问用法时**强制拉一次云端**：站长 2026-11-13 改了文案，旧进程要等 5~10 分钟
     的定时刷新才认，结果连着两次截图都是旧的。问用法是低频操作，多一次请求换「立刻生效」。 */
  if (/(help|用法|说明|怎么用|怎么查|怎么看|有哪些|全部|所有)/i.test(plain)
    || /^[\s?？]+$/.test(plain)) {
    try { await loadSpec(true); } catch { /* 拉不到就用缓存 */ }
  }
  const uTxt = usageFor(c, plain);
  if (uTxt) { await say(chat, uTxt, '[用法] ' + plain.slice(0, 16)); return; }

  /* 不是指令 → 看是不是在跟机器人说话（@ 本号 / ai? 前缀）。指令优先，AI 兜底。 */
  if (!c) {
    const q = aiWanted(m, m.body);
    if (!q) {
      /* 🔴 别再静默：带问号 / 看着像指令却没认出来的，留一行日志。
         不然「机器人不说话」只能靠猜（2026-11-12 整晚都栽在这里）。 */
      if (/[?？]/.test(plain)) log(`没认出来（不当指令也不当提问）：${plain.slice(0, 40)}`);
      return;
    }
    try {
      /* 问「原话」的直出原文；其余交给模型 */
      const raw = await sayRaw(q).catch(() => '');
      if (raw) { await say(chat, raw, '[原话] ' + q.slice(0, 20)); return; }
      /* 🔴 规则没认出的问法：先让模型判断该查什么（它只回工具名+参数，不碰数据），
         查得到就直接发；它说不用查，就用它写的那句回。再不行才退回纯聊天。 */
      const plan = await aiPlan(q, chat);
      if (plan) {
        const tk = String(plan.tool || '').toLowerCase();
        if (tk === 'analyze') {
          const facts = await factsPack(q, '').catch(() => '');
          const txt = await askAnalyze(chat, q, facts);
          if (txt) { await say(chat, txt, '[ai·分析] ' + q.slice(0, 16)); return; }
        } else if (tk && tk !== 'none') {
          const txt = await runTool(plan).catch((e) => { log('工具失败：' + (e && e.message)); return ''; });
          if (txt) { await say(chat, txt, '[工具:' + tk + '] ' + q.slice(0, 16)); return; }
          log('工具没取到数据：' + tk + ' ' + JSON.stringify(plan.args || {}).slice(0, 60));
        } else if (plan.reply) {
          await say(chat, String(plan.reply), '[ai·判不查] ' + q.slice(0, 20));
          return;
        }
      }
      const ans = await askAI(chat, q);
      await say(chat, ans, '[ai] ' + q.slice(0, 24));
    } catch (e) {
      log('AI 失败：' + (e && e.message));
    }
    return;
  }

  /* `fy?…` 显式查发言（站长 2026-11-13：「fy？用来查询个人 队伍的发言」）
     🔴 不另写一套判定：剥掉前缀后把整句交给 naturalCmd，它认出的 say/who/when 直接用；
        认不出才兜底（有队名 ⇒ 队内名单，没队名 ⇒ 当个人去翻原话）。
        这样 `fy?` 和自然语言问法共用同一份规则，不会一个改了一个没改。 */
  if (c.kind === 'fy') {
    const q = String(c.name || '').trim();
    if (!q) {
      await say(chat, 'fy? 这样用：\nfy?林舒晴 近3天\nfy?niii 最近半小时\nfy?队伍 g 昨天\nfy?niii 上午11点', '[fy·用法]');
      return;
    }
    let r = null;
    try { r = await naturalCmd(q); } catch { r = null; }
    if (!r || !/^(say|who|when)$/.test(String(r.kind))) {
      const t = teamOf(q);
      const wq2 = parseWhen(q);
      const off = /前天/.test(q) ? -2 : (/昨天|昨日/.test(q) ? -1 : (/今天|今日/.test(q) ? 0 : null));
      if (t && off !== null) r = { kind: 'when', name: JSON.stringify({ team: t, dayOff: off, wholeDay: true }) };
      else if (t && wq2) r = { kind: 'when', name: JSON.stringify({ team: t, ...wq2 }) };
      else if (t) r = { kind: 'who', name: String(parseMin(q, 5)), team: t };
      /* 个人：sayRaw 有 RAW_ASK 闸门（不含「发言/原话」直接返回空），这里补上措辞 */
      else r = { kind: 'say', name: RAW_ASK.test(q) ? q : q + ' 的发言原话' };
    }
    c = r;
  }

  /* 「黄宣绮今天说话了吗」——只查这一个人，别回全员名单 */
  if (c.kind === 'say') {
    try {
      const txt = await sayRaw(c.name);
      if (txt) await say(chat, txt, '[成员发言] ' + c.name.slice(0, 16));
      else await say(chat, '这个我没认出来是问谁～写成「XX今天说话了吗」再发一次', '[成员发言·没认出来]');
    } catch (e) { log('say 失败：' + (e && e.message)); }
    return;
  }

  /* 「上午11点发言的人呢」「bej 队内今天发言的人有谁」走绝对时间窗 */
  if (c.kind === 'when') {
    try {
      let p = {};
      try { p = JSON.parse(c.name); } catch { p = {}; }
      const txt = await whenReply(p);
      if (txt) await say(chat, txt, `[某时段] ${p.wholeDay ? dayName(p.dayOff) + '全天' : (p.h + '点')}${p.team ? ' ' + p.team : ''}`);
    } catch (e) { log('when 失败：' + (e && e.message)); }
    return;
  }

  /* 「谁在说话」走 /api/who（热窗），不走 /api/cmd */
  if (c.kind === 'who') {
    try {
      const txt = await whoReply(Number(c.name) || 5, c.team || '');
      if (txt) await say(chat, txt, '[谁在说话] 近' + c.name + '分钟' + (c.team ? ' ' + c.team : ''));
      else log('who 没拿到数据');
    } catch (e) { log('who 失败：' + (e && e.message)); }
    return;
  }

  const u = new URL(WORKER + '/api/cmd');
  u.searchParams.set('k', KEY);
  /* `raw` = 云端登记的新指令：原文整句发过去，由 worker 自己解析 */
  u.searchParams.set('q', c.kind === 'raw' ? c.name : (c.kind + '?' + c.name));
  /* 🔴 必须带上是哪个群在问（2026-11-13 站长：「每个群只能查询自己群里的关注」）：
     播报名单（关注？/取关？）按群分开记，没有 chat 云端不知道往哪个群加。 */
  if (chat) u.searchParams.set('chat', chat);

  let r = null;
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(15000) });
    r = await res.json();
  } catch (e) {
    log('指令请求失败：' + (e && e.message));
    return;
  }
  if (!r || !r.ok || !r.reply) { log(`无结果 ${c.kind}:${c.name} → ${JSON.stringify(r).slice(0, 100)}`); return; }

  await say(chat, r.reply, c.kind + ':' + c.name);
  /* 🔴 2026-11-14 站长：「取关了怎么还会抓」。
     根因不是没删，而是**桥这边的推送表还是旧的**：pushMap 每 5 分钟才从云端拉一次，
     取关成功后那几分钟里桥照旧把她的消息往这个群发 —— 用户看到的就是「取关没用」。
     关注/取关改的是云端名单，改完立刻重拉一次，下一件就开始按新名单分发了。 */
  if (c.kind === 'raw' && /^\s*(关注|取关)/.test(String(c.name || ''))) {
    setTimeout(() => { loadCfg(true).catch(() => {}); }, 300);
  }
  /* 指令结果带图（`xfj?` 小房间的〔图〕）：文本发完再逐张补原图。
     2026-11-14 站长：「图片能不能发出来」—— 只贴一行 [图片] 等于没给。
     ⚠️ 每张 = 一次 `messages send`，服务端已限到 ≤3 张，这里再兜一层，失败不重试。 */
  if (Array.isArray(r.imgs) && r.imgs.length) {
    let okN = 0;
    for (const im of r.imgs.slice(0, 3)) {
      if (await sayImage(chat, String(im || ''))) okN++;
      await sleep(700);
    }
    log(`指令补图 ${okN}/${r.imgs.length}（${c.kind}:${c.name}）`);
  }
}

/** 发送失败时把微信的**真实原因**挖出来：receipt(JSON) → resourceId → sends get → errorCode。
 *  2026-11-14 事故：所有群同时「退出码 9」，日志里只有 receipt 路径，谁看都以为代码坏了。
 *  实际查出来是 `state:failed / errorCode:service_rejected` —— **微信服务端拒收**，
 *  跟桥、daemon、CLI 都没关系。这个函数就是把那行原因捞回来的。 */
async function sendDiag(msg) {
  const m = /Submission receipt:\s*(\S+\.json)/i.exec(String(msg || ''));
  if (!m) return '';
  try {
    const rc = JSON.parse(readFileSync(m[1], 'utf8'));
    if (!rc || !rc.resourceId) return '';
    const out = await wx(['--account', ACCOUNT, '--json', 'messages', 'sends', 'get', rc.resourceId], 20000)
      .catch((e) => String((e && e.message) || e));
    /* sends get 失败时也是退出码 9，但 stdout 里就是 JSON，jsonOf 能捞出来 */
    const j = jsonOf(out) || {};
    return [j.state, j.errorCode].filter(Boolean).join('/');
  } catch { return ''; }
}

/** 统一出口：限流 + 截断 + 发送。返回 true = 真发出去了
 *  🔴 必须重试：agent-wechat 的 daemon 同一时刻只受理一个 send，
 *     连续给两个群发时后一条常报 `operation_in_progress`（2026-11-12 实测：
 *     王语晨那条推送到了游戏群、bot小群2 静默丢了）。 */
async function say(chat, text, tag) {
  let body = String(text || '').slice(0, 1800);
  if (!body) return false;
  /* 🔴 本群后缀（2026-11-14 站长：「在群里跟机器人开玩笑加个后缀，这个不要同步到别的群」）：
     存在 learn[chat].suffix 里，key 就是群 id —— 别的群连读都读不到，物理上串不了群。
     ⚠️ 只给 AI 聊天类回复加（tag 形如 `[ai] / [ai·分析] / [分析] / [原话]`）；
        指令结果（榜、鸡腿数）后面挂个玩笑尾巴会很吵，也不像数据。 */
  const suf = String((learn[chat] && learn[chat].suffix) || '').trim();
  if (suf && /^\[(?:ai|分析|原话)/.test(String(tag || '')) && body.indexOf(suf) < 0) {
    body = body.slice(0, 1700) + '\n' + suf;
  }
  if (DRY) { log(`[dry] 会回 ${chat}：${tag}`); return true; }
  /* 每调用一次先清标记：只有真被微信拒收时 noteReject() 会把它置 true，
     上层据此决定「这批别进补发队列」（限流期间补发 = 继续送人头）。 */
  lastSayRejected = false;
  const gap = Date.now() - (lastSent.get(chat) || 0);
  if (gap < COOLDOWN) await sleep(COOLDOWN - gap);
  lastSent.set(chat, Date.now());
  /* 🔴 只试 2 次、每次 20 秒：原来 3 次 × 30 秒 = 90 秒，正好撞上 pump() 的
     90 秒硬上限 ⇒ 整轮被判超时、连「转入补发队列」都来不及执行（2026-11-12 实测）。
     失败要**快速**返回，交给 retryJobs 下一轮再补。 */
  /* 🔴 幂等键（2026-11-14）：`messages send` 会返回「退出码 9：Submission receipt: …」——
     请求已经提交给 daemon，只是这一轮没等到确认。旧代码把它当硬失败立刻重试，
     一旦第一轮其实已经发出，群里就会出现两条一模一样的答复（同一条指令回两遍）。
     带上 `--idempotency-key`（同 chat + 同正文 ⇒ 同 key）以后重试是安全的；
     `--wait` 明确给足 45 秒，让 daemon 有机会在本轮把结果等出来。 */
  const idem = 'br-' + createHash('sha1').update(chat + '\u0000' + body).digest('hex').slice(0, 24);
  for (let i = 1; i <= 2; i++) {
    try {
      await wx(['--account', ACCOUNT, '--json', 'messages', 'send', chat, '--text', body,
        '--idempotency-key', idem, '--wait', '45'], 55000);
      log(`已回群 ${chat}：${tag}${i > 1 ? '（第 ' + i + ' 次成功）' : ''}`);
      rejectStreak = 0;
      if (pauseLevel) log(`✅ 微信恢复发送（原冷却第 ${pauseLevel} 级）⇒ 正常推送，等级清零`);
      pauseLevel = 0; pushPauseUntil = 0;
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      /* receipt = 已提交给 daemon，但这一轮没等到确认 ⇒ 必须再查一次真实结果。
         `service_rejected` 是微信服务端拒收（小号被限流/风控），**重试毫无用处**，
         反而加重风控；遇到它立刻收手，并把原因写进日志。 */
      const receipt = /Submission receipt/i.test(msg);
      const why = receipt ? await sendDiag(msg) : '';
      const rejected = /service_rejected|restricted|blocked|forbidden/i.test(why);
      log(`回群失败 ${chat}（第 ${i}/2 次）${why ? '［' + why + '］' : (receipt ? '［已提交未确认］' : '')}：${msg.slice(0, 200)}`);
      if (rejected) { lastSayRejected = true; noteReject(); return false; }
      if (i < 2) await sleep(receipt ? 2000 : 1200);
    }
  }
  return false;
}

/* ---------------- 王语晨动态：取件 → 转发到群 ---------------- */

/* 🔴 图片必须发真图（2026-11-12 站长：「图片要展示出来具体的图片」）。
 *   抓取端把云信 NOS 直链放进 `img`，这里下载成本地文件再 `--image` 发出去：
 *   · 微信只认本地文件，不认 URL ⇒ 必须先落盘；
 *   · 同一张图（重推/补发）用 md5 命名，命中缓存就不再下第二次；
 *   · 云信 CDN 偶尔 403/超时，失败只记日志、不阻塞后续文本，绝不因一张图拖垮整批。 */
const IMG_DIR = String(process.env.WX_IMG_DIR || `${XDG}/wxbot-img`);
async function sayImage(chat, url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return false;
  if (DRY) { log(`[dry] 会发图 ${chat}：${u.slice(0, 60)}`); return true; }
  try {
    mkdirSync(IMG_DIR, { recursive: true });
    const ext = ((/\.(jpg|jpeg|png|gif|webp)(?:\?|#|$)/i.exec(u) || [])[1] || 'jpg').toLowerCase();
    const file = `${IMG_DIR}/${createHash('md5').update(u).digest('hex').slice(0, 16)}.${ext}`;
    if (!existsSync(file)) {
      const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) { log(`图片下载失败 HTTP ${r.status}：${u.slice(0, 60)}`); return false; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) { log('图片太小，丢弃：' + u.slice(0, 60)); return false; }
      writeFileSync(file, buf);
    }
    const gap = Date.now() - (lastSent.get(chat) || 0);
    if (gap < COOLDOWN) await sleep(COOLDOWN - gap);
    lastSent.set(chat, Date.now());
    await wx(['--account', ACCOUNT, '--json', 'messages', 'send', chat, '--image', file, '--wait', '180'], 200000);
    log(`已发图 ${chat}：${file.split('/').pop()}`);
    return true;
  } catch (e) {
    log('发图失败：' + String((e && e.message) || e).slice(0, 140));
    return false;
  }
}

let pushSeen = [];
let pushSeenSet = new Set();
try {
  const j = JSON.parse(readFileSync(PUSH_SEEN_FILE, 'utf8'));
  pushSeen = Array.isArray(j && j.seen) ? j.seen.map(String) : [];
} catch { pushSeen = []; }
pushSeenSet = new Set(pushSeen);
/** 有没有走过一轮（没走过 = 冷启动，只补最近 15 分钟） */
let pushBooted = pushSeen.length > 0;

/* 🔴 推送失败**不许丢**（2026-11-12 站长：「现在机器人不会推消息了」）
   实况：22:49 有一次 `wx` 命令超时 → say() 三次全失败 → 日志「推送失败，已放弃这一批」，
   而那批 id 早就进了 pushSeen（持久化）⇒ 永久不会重发；云端 `/api/wxb` 取件即清空，
   也留不下备份。结果就是群友看不到那几条，且谁都不知道丢了。
   做法：失败的那批留在本地 retryJobs 里，下一轮**优先**补发；同一批最多试 RETRY_MAX 轮。
   只在内存里，进程重启会丢 —— 够了：真正的死因是「一次超时」，不是进程反复崩。 */
const retryJobs = [];          // {g, text, imgs, tries, tag}
const RETRY_MAX = 4;

/** 本轮先把上一轮没发出去的补掉。返回用掉的毫秒数（给外层 90s 上限留余量）。 */
async function flushRetry(budgetMs) {
  const t0 = Date.now();
  while (retryJobs.length) {
    if (Date.now() - t0 > budgetMs) return;
    const j = retryJobs[0];
    let ok = true;
    if (j.text) ok = await say(j.g, j.text, j.tag + `〔补发${j.tries}〕`);
    for (const im of (j.imgs || [])) {
      const gi = await sayImage(j.g, im);
      if (!gi) ok = false;
      await sleep(600);
    }
    if (ok) {
      retryJobs.shift();
      log(`补发成功（${j.g}，第 ${j.tries} 次补发）`);
      continue;
    }
    j.tries++;
    if (lastSayRejected) {
      retryJobs.length = 0;
      log('⚠️ 补发时被微信拒收 ⇒ 清空补发队列，等冷却结束');
      return;
    }
    if (j.tries > RETRY_MAX) {
      retryJobs.shift();
      log(`⚠️ 补发 ${RETRY_MAX} 次仍失败，放弃这批（${j.g}）：${String(j.text || '').slice(0, 40)}`);
    }
    return;      // 这轮不硬顶，等下一轮
  }
}

function saveSeen() {
  try {
    mkdirSync(dirname(PUSH_SEEN_FILE), { recursive: true });
    writeFileSync(PUSH_SEEN_FILE, JSON.stringify({ seen: pushSeen.slice(-PUSH_SEEN_MAX), at: Date.now() }));
  } catch (e) { log('存推送游标失败：' + (e && e.message)); }
}

const bjHM = (ms) => new Date((Number(ms) || Date.now()) + 8 * 3600e3)
  .toISOString().slice(11, 16);

/* ---------- 群轮转（2026-11-14 限流解封后改） ----------
   事故：一轮把 5 个群连着发（相隔 1.2 秒），被微信判成「群发」⇒ service_rejected、整号禁群发。
   现在：一轮**只发 1 个群**，按顺序轮转，相邻两群隔 5 秒；没轮到的留在 pullBacklog 里，
   下一拍接着发。群多了只是每个群的延迟变大，**发送速率和只推 1 个群基本一样**。 */
const pullBacklog = new Map();     // chatId -> items[]（已取件、还没发出去）
const GROUP_GAP = 5000;            // 相邻两个群之间的最小间隔
let rr = 0;                        // 轮转游标

function pushOrder() {
  return PUSH_MAP.size ? [...PUSH_MAP.keys()] : PUSH_GROUPS.slice();
}

/** 取一次件。items 是 [{id,text,t}]，服务端已经取走即清空 ⇒ 本地 seen 只兜「响应丢了」。 */
async function pullOnce() {
  /* ① 先把上一轮没发出去的补掉（给 40 秒预算，别把 90s 硬上限吃光） */
  await flushRetry(40e3);

  const u = new URL(WORKER + '/api/wxb');
  u.searchParams.set('k', KEY);
  u.searchParams.set('s', 'up');           // 服务端只拿它当心跳，5 分钟补写一次，不耗额度
  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  const d = await res.json().catch(() => null);
  if (!d || !d.ok) { log('取件失败：' + String(JSON.stringify(d)).slice(0, 120)); return; }

  const items = (Array.isArray(d.items) ? d.items : [])
    .filter((x) => x && x.id && (String(x.text || '').trim() || String(x.img || '').trim()));

  /* 冷启动：队列里压着的旧东西一律不发，只放最近 15 分钟进来的 */
  const floor = Date.now() - PUSH_BOOT_FRESH;
  const fresh = [];
  for (const it of items) {
    const id = String(it.id);
    if (pushSeenSet.has(id)) continue;
    pushSeenSet.add(id); pushSeen.push(id);
    if (!pushBooted && (Number(it.t) || 0) < floor) continue;
    fresh.push(it);
  }
  if (items.length) saveSeen();
  if (!pushBooted) { pushBooted = true; if (items.length) log(`冷启动：队列 ${items.length} 条，只发最近 15 分钟的`); }
  if (!fresh.length) return;

  fresh.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));

  /* 🔴 按「这是谁的动态」分派（2026-11-12 站长：游戏群/bot小群2 收王语晨，bot小群 收黄宣绮）。
     PUSH_MAP 没配时退回老规则：PUSH_GROUPS 里的群收**所有人**。
     🔴 2026-11-13 改成「每群一份名单」：空数组 = 这个群**不播任何人**（以前是「全收」），
        想全收请写 `["*"]`。否则取关到空会把群变回「全收」，等于取关失败。 */
  if (!jobsFor(fresh).size) {
    log(`这批 ${fresh.length} 条没有对口的群（who=${[...new Set(fresh.map((x) => x.who || '?'))].join('/')}）`);
    return;
  }
  const n = enqueue(fresh);
  log(`取件 ${fresh.length} 条 → 排队 ${n} 份，待发 ${pullBacklog.size} 个群（轮转，一轮只发 1 个群）`);
}

/** 名单的人话版（日志/启动横幅用）。
 *  🔴 以前写的是 `ws.join('|') || '全部'` —— 空数组被打印成「全部」，
 *     排查「这个群还推不推」时看到全是「全部」，误判成空名单没生效（2026-11-14）。 */
function wsDesc(ws) {
  const a = Array.isArray(ws) ? ws : [];
  if (!a.length) return '（不播）';
  if (a.indexOf('*') >= 0) {
    const blk = a.filter((x) => String(x).charAt(0) === '!').map((x) => String(x).slice(1));
    return '全部' + (blk.length ? '｜屏蔽:' + blk.join(',') : '');
  }
  return a.join('|');
}

/** 把条目按「这是谁的动态」分派到群。返回 Map<群, items[]>（不落地）。
    🔴 按人过滤的口径全在这里：PUSH_MAP 没配时退回 PUSH_GROUPS（那群收所有人）。
    空数组 = 这个群**不播任何人**（想全收写 `["*"]`），否则取关到空会变回「全收」。
    who 为空 = 老客户端 / 手动通知，不按人过滤，所有推送群都发。 */
function jobsFor(items) {
  const targets = pushOrder();
  const jobs = new Map();          // chatId -> items[]
  for (const it of items) {
    const who = String(it.who || '').trim();
    for (const g of targets) {
      const whos = PUSH_MAP.get(g) || [];
      if (who) {
        const blocked = whos.indexOf('!' + who) >= 0;      // 全收群里被单独屏蔽的人
        const all = whos.indexOf('*') >= 0;
        if (blocked || (!all && whos.indexOf(who) < 0)) continue;   // 这群不收她
      }
      if (!jobs.has(g)) jobs.set(g, []);
      jobs.get(g).push(it);
    }
  }
  return jobs;
}

/** 塞进待发队列（同群多条稍后合并成一条发）。 */
function enqueue(items) {
  const jobs = jobsFor(items);
  let n = 0;
  for (const [g, its] of jobs) {
    if (!pullBacklog.has(g)) pullBacklog.set(g, []);
    const arr = pullBacklog.get(g);
    for (const it of its) { arr.push(it); n++; }
    if (arr.length > 60) pullBacklog.set(g, arr.slice(-60));   // 别无限涨
  }
  return n;
}

/** 发掉**一个**群（按轮转顺序取下一个有货的群）。
 *  返回 'sent' | 'empty' | 'rejected'；rejected = 微信拒收，上层立刻停手。
 *  🔴 2026-11-14 限流事故之后改成「一轮只发一个群、群间隔 5 秒」：
 *     原来一轮 5 个群连着发（间隔 1.2 秒）正是被判成群发的样子。群多了只是延迟变大，
 *     发送速率和只推 1 个群时基本一样。 */
async function flushOne() {
  const order = pushOrder();
  if (!order.length) return 'empty';
  for (let k = 0; k < order.length; k++) {
    const g = order[(rr + k) % order.length];
    const its = pullBacklog.get(g);
    if (!its || !its.length) continue;
    rr = (rr + k + 1) % order.length;      // 下一轮从它后面那个群接着发
    pullBacklog.delete(g);
    const r = await sendGroup(g, its);
    return r === 'rejected' ? 'rejected' : 'sent';
  }
  return 'empty';
}

/** 真正发一个群：合并文本 + 补发图片。 */
async function sendGroup(g, its) {
  /* 同一个群一轮的多条合成一条发：她有时连发五六句，逐条发会把群刷满。
     每条自带 `[HH:mm:ss] 昵称…` 头，直接空行拼接就行。
     图片条目 text 为空（只有 img），拼文本时跳过，别拼出一堆空行。 */
  const texts = its.map((x) => String(x.text || '')).filter((t) => t.trim());
  const imgs = its.map((x) => String(x.img || '').trim()).filter(Boolean);
  const text = (texts.length === 1 ? texts[0] : texts.join('\n\n')).slice(0, 1700);

  /* 🔴 测试/自检文案**永远不进群**（站长 2026-11-12：「这个出现在哪几个群就不要一起发了 不太好哈」）。
     守卫只认【自检】/【测试】/通道自检/推送通道测试 这几种固定写法，
     她正常发言里出现「测试」两个字（如「测试一下直播」）不会被误拦。
     要验证推送，跑 `node wxbot/agent-wechat-bridge.mjs --dry`（只记不发）。 */
  if (text && /(?:【\s*(?:自检|测试)[^】]*】|通道自检|推送通道测试|推送通道自检)/.test(text)) {
    log('拦下测试文案，未发群：' + text.replace(/\s+/g, ' ').slice(0, 50));
    return 'skipped';
  }

  let ok = true;
  if (text) {
    /* 日志带上首行摘要：以前只打「[推送] N 条 15:31」，事后根本分不清推的是
       房间消息还是上下线播报（2026-11-12 排查「上线没推到群」时吃过这个亏）。 */
    const brief = String(texts[0] || '').replace(/\s+/g, ' ').slice(0, 26);
    /* 标签按「本批里到底有几条是上下线」算。原来直接对整个 text 做 /[💡🕑]/，
       只要一批里混了一条上下线，整批都会被标成 [上下线]，看不出混发。 */
    const onOffN = its.filter((x) => /^[💡🕑]/.test(String(x.text || '').trim())).length;
    const tag = !onOffN ? '推送' : onOffN === its.length ? '上下线' : `推送+上下线${onOffN}`;
    ok = await say(g, text, `[${tag}] ${its.length} 条 ${bjHM(its[its.length - 1].t)} ${brief}`);
    if (!ok) {
      /* 🔴 限流拒收**不进补发队列**：那不是「这次没发成功」，是「这个号现在不许发」，
         补发一次就多送一次人头，反而拖长限制期。这批 id 已进 pushSeen，所以不会重发
         —— 限流期间丢几条推送，是可接受的代价。 */
      if (lastSayRejected) {
        log(`推送被微信拒收，不再补发（${g}）：${String(text).replace(/\s+/g, ' ').slice(0, 40)}`);
        return 'rejected';
      }
      log(`推送失败，转入补发队列（${g}）`);
      retryJobs.push({
        g, text, imgs, tries: 1,
        tag: `[${tag}] ${its.length} 条 ${bjHM(its[its.length - 1].t)} ${brief}`,
      });
    }
  }
  /* 文本之后逐张补发真图；一张失败不影响其余 */
  for (const im of imgs) {
    const gi = await sayImage(g, im);
    if (!gi) log(`图片没发出去（${g}）`);
    await sleep(600);
  }
  return ok ? 'ok' : 'failed';
}

/** 长轮询：每 PUSH_EVERY 秒一次，永不退出；单次异常只记日志，不影响下一条 */
async function pump() {
  const desc = PUSH_MAP.size
    ? [...PUSH_MAP.entries()].map(([g, ws]) => g + '←' + wsDesc(ws)).join('，')
    : (PUSH_GROUPS.join(',') || '关（没配 WX_PUSH_GROUPS / WX_PUSH_MAP）');
  log(`推送通道：${desc}，每 ${Math.round(PUSH_EVERY / 1000)} 秒取件（一轮只发 1 个群，轮转，群间隔 ${GROUP_GAP / 1000}s）`);
  if (!PUSH_MAP.size && !PUSH_GROUPS.length) return;
  for (;;) {
    /* 被微信连续拒收期间**不要取件**：取出来也发不出去，只会堆进 retryJobs 并在
       下一轮重放，等于持续给风控送人头。留在云端队列里等解封后一次性发更划算。 */
    if (Date.now() < pushPauseUntil) { await sleep(15000); continue; }
    try {
      /* 🔴 硬超时兜底：pullOnce 里只要有一次 `wx` 调用卡住，整个取件循环就永久停摆，
         队列里的推送会一直躺着（2026-11-12 实测：16:00 的下线播报在队列里躺了
         90 分钟，直到手动重启桥才发出去 —— 表现就是站长说的「推送到群里丢失了」）。
         这里 race 一个 90 秒上限，卡住就抛错、下一轮重新取件。 */
      await Promise.race([
        pullOnce(),
        sleep(90e3).then(() => { throw new Error('取件超时 90s，重开一轮'); }),
      ]);
      /* 把待发队列按轮转发完：一轮一个群、群间隔 GROUP_GAP；被拒立刻停手（冷却交给 noteReject） */
      while (pullBacklog.size) {
        const r = await flushOne();
        if (r !== 'sent') break;
        if (pullBacklog.size) await sleep(GROUP_GAP);
      }
    } catch (e) { log('取件异常：' + (e && e.message)); }
    await sleep(PUSH_EVERY);
  }
}

/* ---------------- 远程控制台（桥侧执行器） ----------------
   站长 2026-11-13：「那台电脑我不一定在，能不能远程操控？」

   能，而且不用公网 IP / 内网穿透 / SSH —— 桥本来就一直往云端取件（推送走 /api/wxb），
   控制通道照同一个形状做：**云端排队 → 桥 10 秒轮询 → 本地跑 → 回传结果**。
   云端只负责排队，永远不直接连这台机器。

   🔴 只认下面 switch 里那几个 op，**不接任意 shell**。
   🔴 restart / update 是「先回传结果再退出」：容器是 --restart unless-stopped，
      退出即自动拉起，等于远程重启，不需要容器里有 docker 命令。 */

const CTL_EVERY = 10 * 1000;
const SELF = String(process.argv[1] || '');
const QR_BASE = '/tmp/all48-login-qr.png';

/* 版本 = 自身文件 sha1 前 8 位。改没改一眼看得出来，不用手工维护版本号。 */
let SELF_VER = '';
try { SELF_VER = createHash('sha1').update(readFileSync(SELF)).digest('hex').slice(0, 8); } catch { }

/* 登录态缓存：`wx accounts list` 一次要 0.5~2 秒，不能 10 秒跑一次 */
let AUTH = { at: 0, online: false, groups: 0, raw: '' };

async function ctlAuth(force) {
  if (!force && Date.now() - AUTH.at < 60e3) return AUTH;
  try {
    /* 用 list 而不是 status：deploy 脚本里一直用 `Authenticated: Yes` 判断，行格式是验证过的 */
    const out = await wx(['accounts', 'list'], 15000);
    const online = /Authenticated:\s*Yes/i.test(out);
    const conn = (/Connection:\s*(.+)/i.exec(out) || [])[1] || '';
    AUTH = {
      at: Date.now(), online, groups: AUTH.groups,
      raw: (online ? '在线' : '离线') + (conn ? '（' + conn.trim().slice(0, 24) + '）' : ''),
    };
  } catch (e) {
    AUTH = { at: Date.now(), online: false, groups: AUTH.groups, raw: '读到失败：' + String((e && e.message) || e).slice(0, 80) };
  }
  return AUTH;
}

function fmtSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
}

/** 二维码文件：`--qr-output x.png` 首次是 x.png，自动刷新会写 x-1.png / x-2.png…
 *  取**最新**那个，否则扫码时看到的是早就过期的那张。 */
function newestQr() {
  try {
    const dir = '/tmp';
    const base = 'all48-login-qr';
    let best = null, bt = -1;
    for (const f of readdirSync(dir)) {
      if (f !== base + '.png' && !new RegExp('^' + base + '-\\d+\\.png$').test(f)) continue;
      try {
        const st = statSync(dir + '/' + f);
        if (st.mtimeMs > bt) { bt = st.mtimeMs; best = dir + '/' + f; }
      } catch { }
    }
    return best;
  } catch { return null; }
}

async function ctlRes(R) {
  try {
    const u = new URL(WORKER + '/api/ctl/res');
    u.searchParams.set('k', KEY);
    await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(R),
      signal: AbortSignal.timeout(15000),
    });
  } catch { /* 回传失败就算了，别把循环带崩 */ }
}

/** 执行一条指令。返回 true 表示这条会退出进程（重启/更新），调用方别再往下跑。 */
async function ctlRun(c) {
  const op = String(c.op || '');
  const t0 = Date.now();
  const R = { id: c.id, op, ok: false, out: '' };
  let quit = false;

  try {
    if (op === 'status') {
      const a = await ctlAuth(true);
      R.info = {
        account: ACCOUNT, online: !!a.online, ver: SELF_VER,
        up: Math.round(process.uptime()), groups: AUTH.groups || 0,
      };
      R.out = [
        '账号　' + ACCOUNT,
        '登录　' + (a.online ? '已登录 / 在线' : '未登录 / 断开'),
        '进程　已跑 ' + fmtSpan(process.uptime()),
        '版本　' + (SELF_VER || '?'),
        '队列　推送 ' + (PUSH_MAP.size || PUSH_GROUPS.length ? '开' : '关')
          + '（每 ' + Math.round(PUSH_EVERY / 1000) + ' 秒）· AI ' + (AI_ON ? '开' : '关'),
        a.raw ? 'CLI　 ' + a.raw : '',
      ].filter(Boolean).join('\n');
      R.ok = true;

    } else if (op === 'qr') {
      try { unlinkSync(QR_BASE); } catch { }
      /* --detach：立即返回，不阻塞 5 分钟等扫码；--force-qr：跳过设备信任，强制出码 */
      const out = await wx(['auth', 'login', '--strategy', 'qr', '--force-qr',
        '--qr-output', QR_BASE, '--detach', '--json'], 30000);
      let f = null;
      for (let i = 0; i < 30 && !f; i++) { await sleep(500); f = newestQr(); }
      if (!f) {
        R.out = '没等到二维码文件。CLI 原始输出：\n' + String(out || '').slice(0, 800);
      } else {
        const b64 = readFileSync(f).toString('base64');
        R.qr = 'data:image/png;base64,' + b64;
        R.out = '二维码已生成（' + Math.round(b64.length / 1024) + 'KB）：用手机微信「扫一扫」扫上面的图。'
          + '\n二维码约 2 分钟过期，过期再点一次即可。';
        R.ok = true;
      }

    } else if (op === 'groups') {
      const out = await wx(['--json', 'groups', 'list'], 30000);
      const j = jsonOf(out);
      const arr = Array.isArray(j) ? j
        : (j && (j.items || j.groups || j.list || j.entries)) || [];
      if (!Array.isArray(arr) || !arr.length) {
        R.out = '没解析出群列表。CLI 原始输出：\n' + String(out || '').slice(0, 900);
      } else {
        R.groups = arr.slice(0, 300).map((g) => ({
          n: String(g.name || g.nickname || g.displayName || g.topic || g.title || g.id || ''),
          id: String(g.id || g.chatId || g.groupId || ''),
          m: Number(g.memberCount || g.membersCount || g.members || 0) || '',
        }));
        AUTH.groups = arr.length;
        R.out = '共 ' + arr.length + ' 个群，已同步到上面的列表。';
        R.ok = true;
      }

    } else if (op === 'logs') {
      const txt = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : '';
      /* 行数可调（默认 60）：排查「某条指令为什么没回」时要往前翻到那条消息，
         60 行只够 5 分钟，一转眼就被推送日志挤掉了（2026-11-14）。上限 400 防撑爆回传。
         ⚠️ 参数得从 `args` 里取：CtlDO 只存 args，顶层 `n` 在云端就被丢了。 */
      const want = Math.min(400, Math.max(10, Number(c.args && (c.args.n || c.args[0])) || 60));
      const ln = txt.split('\n').filter((x) => x.trim()).slice(-want);
      R.out = ln.length ? ln.join('\n') : '（还没有日志）';
      R.ok = true;

    } else if (op === 'file') {
      /* 🔴 只读文本，只允许 /app/data 下的 .json/.log —— 用来读 CLI 写下的
         `receipts/*.json`（发送凭据）。排查「exit 9 / Submission receipt」时，
         receipt 里写着这次发送到底 pending 还是 failed，比猜一百遍都快。
         ⚠️ 云端 CtlDO 只透传 `args` 字段（其它字段在 /cmd 就被丢掉了），
            所以路径必须放在 `args` 里：{op:'file', args:{p:'/app/data/xxx.json'}}。 */
      const f = String((c.args && (c.args.p || c.args.path || c.args[0])) || '').slice(0, 300);
      if (!/^\/app\/data\/[\w./-]+\.(json|log)$/.test(f) || f.indexOf('..') >= 0) {
        R.out = 'file 只允许读 /app/data 下的 .json / .log';
      } else if (!existsSync(f)) {
        R.out = '文件不存在：' + f;
      } else {
        const t = readFileSync(f, 'utf8');
        R.out = (t.length > 1600 ? t.slice(0, 1600) + '\n…（共 ' + t.length + ' 字）' : t);
        R.ok = true;
      }

    } else if (op === 'wxraw') {
      /* 🔴 只读诊断口：把一条 wx 子命令的**原始 stdout/退出码**回传，用来判断
         「退出码 9 / Submission receipt」到底是没发出去、还是已提交没等到确认。
         白名单只放只读子命令；`messages send` 单独允许（排查发送必须用它），
         其他一律拒 —— 绝不能变成任意 shell。 */
      const a2 = (Array.isArray(c.args) ? c.args : []).map((x) => String(x).slice(0, 300)).slice(0, 12);
      const head = String(a2[0] || '');
      if (!/^(operations|jobs|status|chats|messages|accounts|version|auth|daemon)$/.test(head)) {
        R.out = 'wxraw 只允许：operations / jobs / status / chats / messages / accounts / version / auth / daemon';
      } else {
        let o2 = '', e2 = '';
        try {
          o2 = await wx(['--account', ACCOUNT, '--json', ...a2], 90000);
        } catch (e) { e2 = String((e && e.message) || e); }
        let txt = '$ wx --json ' + a2.join(' ') + '\n' + (o2 || e2);
        /* 🔴 超长要**留尾部**：`daemon logs` 一次能吐几万字，错误永远在最后几行，
           截前 1800 字等于只看到整篇日志的开头（2026-11-14 白跑一次）。 */
        if (txt.length > 1800) {
          txt = txt.slice(0, 400) + '\n…（中间省略 ' + (txt.length - 1700) + ' 字）…\n' + txt.slice(-1300);
        }
        R.out = txt;
        R.ok = !e2;
      }

    } else if (op === 'exec') {
      /* 🔴 容器内的通用执行口（2026-11-14 新增，为了把 nim-client 搬上来）。
         上面几个口是「白名单只读」，这个口不是 —— 它等于容器里一个 shell。
         为什么必须有：这台机器没有任何其它入站方式（SSH 不在我们手里），
         而要在上面装第二个常驻进程（云信长连接 → 微信秒推），只能靠它下发文件+起进程。
         风险边界：和 `restart` 同级别 —— 都是拿到控制口令才能下发。
         ⇒ 每条都写日志（谁在什么时候跑了什么），参数只从 `args` 取（CtlDO 只存 args）。
         用法：{op:'exec', args:{cmd:'node -v; pwd', timeout:60}} */
      const cmd = String((c.args && (c.args.cmd || c.args[0])) || '');
      const to = Math.min(300, Math.max(5, Number(c.args && c.args.timeout) || 60)) * 1000;
      if (!cmd) {
        R.out = 'exec 需要 args.cmd';
      } else if (cmd.length > 400000) {
        R.out = 'cmd 太长（' + cmd.length + ' 字节，上限 400000）';
      } else {
        const r = await new Promise((res) => {
          let out = '', err = '', done = false;
          const fin = (code, timed) => {
            if (done) return;
            done = true;
            try { p.kill('SIGKILL'); } catch { }
            res({ code, out, err, timed });
          };
          const p = spawn('/bin/sh', ['-c', cmd], { cwd: '/app', env: process.env });
          const tm = setTimeout(() => fin(null, true), to);
          p.stdout.on('data', (d) => { if (out.length < 120000) out += d.toString(); });
          p.stderr.on('data', (d) => { if (err.length < 30000) err += d.toString(); });
          p.on('error', (e) => { err += 'spawn 失败：' + String((e && e.message) || e); fin(-1, false); });
          p.on('close', (code) => { clearTimeout(tm); fin(code, false); });
        });
        /* 回传只留尾部：装依赖/编译时前面几千行都是噪音，错误永远在最后 */
        let txt = 'exit=' + (r.timed ? 'TIMEOUT(' + Math.round(to / 1000) + 's)' : r.code) + '\n' + (r.out || '');
        if (r.err) txt += '\n[stderr] ' + r.err;
        if (txt.length > 6000) txt = txt.slice(0, 800) + '\n…（省略 ' + (txt.length - 6800) + ' 字）…\n' + txt.slice(-5200);
        R.out = txt;
        R.ok = !r.timed && r.code === 0;
        R.ms = Date.now() - t0;
        log('控制台：exec「' + cmd.replace(/\s+/g, ' ').slice(0, 80) + '」→ ' + (r.timed ? '超时' : 'exit ' + r.code));
      }

    } else if (op === 'restart') {
      R.out = '已收到重启指令，3 秒后重启（容器 unless-stopped 会自己拉起来）';
      R.ok = true;
      R.ms = Date.now() - t0;
      await ctlRes(R);
      log('控制台：收到重启指令');
      setTimeout(() => process.exit(0), 1200);
      return true;

    } else if (op === 'update') {
      const r = await fetch(WORKER + '/api/wb/bridge-k7f2', { signal: AbortSignal.timeout(40000) });
      if (!r.ok) throw new Error('下载失败 HTTP ' + r.status);
      const txt = await r.text();
      if (txt.length < 20000 || !/agent-wechat/.test(txt.slice(0, 1200))) {
        throw new Error('下载到的不是桥程序（' + txt.length + 'B）');
      }
      const next = createHash('sha1').update(txt).digest('hex').slice(0, 8);
      if (next === SELF_VER) {
        R.out = '云端就是当前版本（' + next + '），不用更新。';
        R.ok = true;
      } else {
        /* 🔴 临时文件必须还是 `.mjs` 结尾：写成 `xxx.mjs.next` 时 node --check 会报
           ERR_UNKNOWN_FILE_EXTENSION（它按扩展名判模块类型），于是**每次更新都失败**，
           桥永远停在旧版（2026-11-13 排查「关注？回了『要在群里发』」时才发现的）。 */
        const tmp = SELF.replace(/\.mjs$/, '') + '.next.mjs';
        writeFileSync(tmp, txt);
        /* 🔴 先 node --check：语法不过关就绝不覆盖，否则容器会陷入无限重启，
           而那时人不在机器旁边，只能干看着。 */
        await new Promise((res, rej) => {
          const p = spawn(process.execPath, ['--check', tmp], { stdio: 'ignore' });
          p.on('error', rej);
          p.on('close', (code) => (code === 0 ? res() : rej(new Error('新文件语法检查没过（退出码 ' + code + '）'))));
        });
        const bak = SELF + '.bak.' + new Date().toISOString().slice(11, 16).replace(/[:]/g, '');
        writeFileSync(bak, readFileSync(SELF));
        writeFileSync(SELF, txt);
        try { unlinkSync(tmp); } catch { }
        R.out = '已更新：' + SELF_VER + ' → ' + next + '\n旧版留在 ' + bak.split('/').pop() + '，1 秒后重启生效。';
        R.ok = true;
        R.ms = Date.now() - t0;
        await ctlRes(R);
        log('控制台：更新完成 ' + SELF_VER + ' → ' + next + '，重启');
        setTimeout(() => process.exit(0), 1200);
        return true;
      }

    } else {
      R.out = '不认识的指令：' + op;
    }
  } catch (e) {
    R.out = '执行失败：' + String((e && e.message) || e).slice(0, 400);
  }

  if (quit) return true;
  R.ms = Date.now() - t0;
  await ctlRes(R);
  log('控制台：' + (R.ok ? '完成' : '失败') + ' ' + op + ' ' + R.ms + 'ms');
  return false;
}

async function ctlOnce() {
  const a = await ctlAuth(false);
  const u = new URL(WORKER + '/api/ctl/poll');
  u.searchParams.set('k', KEY);
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: ACCOUNT, online: !!a.online, groups: AUTH.groups || 0,
      ver: SELF_VER, up: Math.round(process.uptime()),
    }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await r.json().catch(() => null);
  if (!d || !d.ok) return;
  for (const c of (Array.isArray(d.cmds) ? d.cmds : [])) {
    const quit = await ctlRun(c);
    if (quit) return;
  }
}

async function ctlLoop() {
  if (!KEY) return;
  log('控制台：已接管，每 ' + Math.round(CTL_EVERY / 1000) + ' 秒取一次指令');
  for (;;) {
    try { await ctlOnce(); } catch { /* 网络抖动不刷屏，下一轮再说 */ }
    await sleep(CTL_EVERY);
  }
}

/* ---------------- 主流程 ---------------- */

/* 🔴 退出时一定要把 wx 子进程带走：父进程被 SIGTERM 时 spawn 出来的子进程会变孤儿，
   残留在后台继续读事件流，越积越多（2026-11-12 实测攒到 5 个）。 */
let cur = null;
function bye() {
  try { if (cur) cur.kill('SIGKILL'); } catch { }
  process.exit(0);
}
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
process.on('exit', () => { try { if (cur) cur.kill('SIGKILL'); } catch { } });

async function ping() {
  const u = new URL(WORKER + '/api/cmd');
  u.searchParams.set('k', KEY);
  u.searchParams.set('q', 'lg?王语晨');
  const r = await (await fetch(u, { signal: AbortSignal.timeout(15000) })).json();
  log('自检：', JSON.stringify(r).slice(0, 160));
  process.exit(r && r.ok ? 0 : 1);
}

/** 起 wx messages watch，断了自己重连。事件流是 JSONL，一行一个事件。 */
function watch() {
  const args = ['--account', ACCOUNT, '--json', 'messages', 'watch', '--cursor-file', CURSOR];
  log(`启动：account=${ACCOUNT} 群=${GROUPS.join(',') || '全部'} 需@=${REQUIRE_MENTION ? '是' : '否'} AI=${AI_ON ? (AI_VIA_WORKER ? 'CF qwen（免费额度）' : AI_MODEL) : '关'}${DRY ? ' [dry]' : ''}`);
  const p = spawn(WX, args, { env: { ...process.env, XDG_CONFIG_HOME: XDG }, stdio: ['ignore', 'pipe', 'pipe'] });
  cur = p;

  let buf = '';
  let chain = Promise.resolve();       // 串行处理，别并发开一堆 wx 进程
  const oddKind = new Set();           // 每种没认的事件类型只提示一次，免得刷屏

  p.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line[0] !== '{') continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind !== 'message.committed') {
        /* 🔴 事件类型对不上时以前是直接 continue，等于「事件流在跑但一条都不用」，
           日志上完全看不出来。现在每种类型提示一次。 */
        if (ev.kind && !oddKind.has(ev.kind)) {
          oddKind.add(ev.kind);
          log('忽略事件类型：' + String(ev.kind).slice(0, 40));
        }
        continue;
      }
      chain = chain.then(() => handle(ev)).catch((e) => {
        /* 🔴 打全栈：只打 message 的话（`msgTimeMs is not defined`）看不出在哪一行，
           上次就是这么瞎猜了一晚。 */
        log('处理异常：' + String((e && (e.stack || e.message)) || e).split('\n').slice(0, 4).join(' | '));
      });
    }
  });
  p.stderr.on('data', (d) => {
    const s = String(d).trim();
    if (s) log('wx: ' + s.slice(0, 200));
  });
  p.on('close', (code) => {
    log(`事件流断开（${code}），5 秒后重连`);
    setTimeout(watch, 5000);
  });
  p.on('error', (e) => {
    log('起不来：' + e.message + '，5 秒后重试');
    setTimeout(watch, 5000);
  });
}

if (PING) { await ping(); }
else {
  /* 指令前缀表：启动先拉一次，之后每 5 分钟刷新（内部 TTL 10 分钟，双保险）。
     拉不到就用文件缓存 / 内置默认，绝不影响启动。 */
  void loadSpec(true);
  setInterval(() => { void loadSpec(); }, 2 * 60 * 1000);
  /* 云端配置：启动先取一次（10 秒超时，拉不到就用 env），之后每 5 分钟刷。
     放在 pump/watch 之前 —— 这样「启动：…群=…」那行打的就是**生效后**的值。 */
  /* 先吃上次缓存（断网也有配置），再问云端要最新的一份 */
  if (!(await loadCfg(true)) && cachedCfg) {
    cfgApply(cachedCfg);
    log('沿用上次缓存的云端配置（v' + (cachedCfg.v || 1) + '）');
  }
  if (!cachedCfg) {
    cfgApply(CFG_DEFAULTS);
    log('⚠️ 从没拿到过云端配置，先用内置默认跑（指令群=全部，推送=关）');
  }
  setInterval(() => { void loadCfg(); }, 5 * 60 * 1000);

  /* 随容器一起起「外挂服务」（2026-11-14）：容器 unless-stopped，桥重启=这些进程全没了，
     所以在桥启动时把它们拉起来。现在只有一个：云信长连接（成员发言 → 微信秒推）。
     判存在才起，脚本自己 nohup + 死循环重生；起不来也不影响桥本身。 */
  try {
    if (existsSync('/app/nim/run.sh')) {
      const p = spawn('/bin/sh', ['/app/nim/run.sh'], { detached: true, stdio: 'ignore' });
      p.unref();
      log('外挂服务：已拉起 nim（云信长连接 → 微信秒推）');
    }
  } catch (e) {
    log('外挂服务拉起失败：' + String((e && e.message) || e).slice(0, 100));
  }

  pump();
  void ctlLoop();
  watch();
}
