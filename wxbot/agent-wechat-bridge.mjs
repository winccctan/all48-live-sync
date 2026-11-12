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
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

const WX = String(process.env.WX_BIN || `${process.env.HOME}/.workbuddy/binaries/agent-wechat/bin/wx`);
const ACCOUNT = String(process.env.WX_ACCOUNT || 'test48');
const XDG = String(process.env.XDG_CONFIG_HOME || '/tmp/awcfg');   // 🔴 必须在可写区，否则原子重命名被沙箱拒
const WORKER = (process.env.WORKER_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const KEY = String(process.env.WX_QUEUE_TOKEN || '');
/** 允许的群：chatroom id（如 53524154991@chatroom），逗号分隔；留空 = 所有群 */
const GROUPS = String(process.env.WX_GROUPS || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
/** 是否必须 @ 本号才响应。默认 0 = 不需要 @（站长 2026-11-12 要求） */
const REQUIRE_MENTION = String(process.env.WX_REQUIRE_MENTION || '0') === '1';
const CURSOR = String(process.env.WX_CURSOR_FILE || `${XDG}/wxbot-cursor`);
const COOLDOWN = Math.max(500, Number(process.env.WX_COOLDOWN || 1500));
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
const AI_DAILY = Math.max(1, Number(process.env.AI_DAILY || 120));
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
const PUSH_GROUPS = String(process.env.WX_PUSH_GROUPS || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
/** 群 → 该群要收**谁**的动态（2026-11-12 站长：「bot小群对接黄宣绮」「游戏群、bot小群2 收王语晨」）。
 *  env 写法：`WX_PUSH_MAP=53524154991@chatroom=王语晨,54162053602@chatroom=王语晨,57498523864@chatroom=黄宣绮`
 *  一个群收多人用 `|`：`…=王语晨|黄宣绮`。
 *  🔴 配了 MAP 就只看 MAP（比 WX_PUSH_GROUPS 优先）；没配才退回老行为（这些群收所有人）。 */
const PUSH_MAP = (() => {
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
const PUSH_EVERY = Math.max(3000, Number(process.env.WX_PUSH_EVERY || 6000));
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
      reject(new Error(`wx 退出码 ${code}：${(err || out).trim().slice(0, 200)}`));
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
  return null;
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
const BOT_NAMES = String(process.env.WX_BOT_NAMES || 'boooot,小48,机器人,48bot')
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
  const genericQ = /(谁|哪些|哪个|几个|多少人|多少位|名单|大家|有人|成员|都在|都谁)/.test(s);
  const timeRef = /(今天|今日|当天|昨天|昨日|前天|最近|刚才|刚刚|\d{1,2}\s*[月\-\/.]\s*\d{1,2}|\d+\s*天)/.test(s);
  if (sayVerb && !genericQ && timeRef && !dataQ) return { kind: 'say', name: s };
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

  /* 「年度之星第一是谁 / 前 20」这种没有具体人名的，直接给总榜 */
  if (kind === 'mvp' && /第一|谁|排行|榜|前\s*\d+/.test(s)) {
    const tm = /前\s*(\d{1,3})/.exec(s);
    return { kind: 'mvp', name: 'top' + Math.min(50, Number(tm && tm[1]) || 10) };
  }

  const tw = /(广州联合|川渝联合|预备生|IDFT)|(?:team\s*)?\b(niii|nii|sii|hii|snh|gnz|bej|cgt|ckg)\b/i.exec(s);
  if (tw) return { kind, name: String(tw[1] || tw[2] || '').trim() };

  try {
    const u = new URL(WORKER + '/api/mem');
    u.searchParams.set('k', KEY);
    u.searchParams.set('q', s);
    const d = await (await fetch(u, { signal: AbortSignal.timeout(12000) })).json();
    if (d && d.ok && d.name) return { kind, name: d.name };
  } catch { }
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
    { role: 'system', content: [AI_SYS, learnCtx(chat), who, ctx, mem].filter(Boolean).join('\n\n') },
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

/* ---------------- 处理一条 ---------------- */

async function handle(ev) {
  const d = ev.data || {};
  if (d.direction !== 'incoming') return;
  const chat = String(d.threadId || '');
  if (!chat.endsWith('@chatroom')) return;                    // 只做群，私聊不接（免得小号私聊被刷）
  if (GROUPS.length && !GROUPS.includes(chat)) return;
  if (seen(String(d.messageId))) return;

  const j = jsonOf(await wx(['--account', ACCOUNT, '--json', 'messages', 'get', String(d.messageId)]));
  const m = (j && (j.message || j)) || null;
  if (!m) return;
  if (Number(m.type) !== 1) return;                           // 只要纯文本，图片/引用/文件一概略过

  const men = m.mentions || {};
  if (REQUIRE_MENTION && !men.self && !men.all) return;

  const body = String(m.body || '');
  /* 手打 `@boooot lg?bej` 也要认：微信没给 atuserlist 时正文里就带着 @名字，剥掉再解析一次 */
  const stripped = body.replace(/^@[^\s\u2005]+[\s\u2005]+/, '');
  const plain = stripped || body;
  let c = cmdOf(body) || (stripped !== body ? cmdOf(stripped) : null);
  /* 自然语言查询（「帮我查陈淑钰的鸡腿」）—— 必须先于 AI，否则模型拿红蓝分冒充鸡腿 */
  if (!c) { try { c = await naturalCmd(plain); } catch { c = null; } }

  /* 不是指令 → 看是不是在跟机器人说话（@ 本号 / ai? 前缀）。指令优先，AI 兜底。 */
  if (!c) {
    const q = aiWanted(m, m.body);
    if (!q) return;
    try {
      /* 问「原话」的直出原文；其余交给模型 */
      const raw = await sayRaw(q).catch(() => '');
      if (raw) { await say(chat, raw, '[原话] ' + q.slice(0, 20)); return; }
      const ans = await askAI(chat, q);
      await say(chat, ans, '[ai] ' + q.slice(0, 24));
    } catch (e) {
      log('AI 失败：' + (e && e.message));
    }
    return;
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
  u.searchParams.set('q', c.kind + '?' + c.name);

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
}

/** 统一出口：限流 + 截断 + 发送。返回 true = 真发出去了
 *  🔴 必须重试：agent-wechat 的 daemon 同一时刻只受理一个 send，
 *     连续给两个群发时后一条常报 `operation_in_progress`（2026-11-12 实测：
 *     王语晨那条推送到了游戏群、bot小群2 静默丢了）。 */
async function say(chat, text, tag) {
  const body = String(text || '').slice(0, 1800);
  if (!body) return false;
  if (DRY) { log(`[dry] 会回 ${chat}：${tag}`); return true; }
  const gap = Date.now() - (lastSent.get(chat) || 0);
  if (gap < COOLDOWN) await sleep(COOLDOWN - gap);
  lastSent.set(chat, Date.now());
  for (let i = 1; i <= 3; i++) {
    try {
      await wx(['--account', ACCOUNT, '--json', 'messages', 'send', chat, '--text', body]);
      log(`已回群 ${chat}：${tag}${i > 1 ? '（第 ' + i + ' 次成功）' : ''}`);
      return true;
    } catch (e) {
      const msg = String((e && e.message) || e);
      log(`回群失败 ${chat}（第 ${i}/3 次）：${msg.slice(0, 120)}`);
      if (i < 3) await sleep(900 * i);
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

function saveSeen() {
  try {
    mkdirSync(dirname(PUSH_SEEN_FILE), { recursive: true });
    writeFileSync(PUSH_SEEN_FILE, JSON.stringify({ seen: pushSeen.slice(-PUSH_SEEN_MAX), at: Date.now() }));
  } catch (e) { log('存推送游标失败：' + (e && e.message)); }
}

const bjHM = (ms) => new Date((Number(ms) || Date.now()) + 8 * 3600e3)
  .toISOString().slice(11, 16);

/** 取一次件。items 是 [{id,text,t}]，服务端已经取走即清空 ⇒ 本地 seen 只兜「响应丢了」。 */
async function pullOnce() {
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
     PUSH_MAP 没配时退回老规则：PUSH_GROUPS 里的群收**所有人**。 */
  const targets = PUSH_MAP.size ? [...PUSH_MAP.keys()] : PUSH_GROUPS;
  const jobs = new Map();          // chatId -> items[]
  for (const it of fresh) {
    const who = String(it.who || '').trim();
    for (const g of targets) {
      const whos = PUSH_MAP.get(g) || [];
      if (whos.length && who && whos.indexOf(who) < 0) continue;   // 这群不收她
      if (!jobs.has(g)) jobs.set(g, []);
      jobs.get(g).push(it);
    }
  }
  if (!jobs.size) {
    log(`这批 ${fresh.length} 条没有对口的群（who=${[...new Set(fresh.map((x) => x.who || '?'))].join('/')}）`);
    return;
  }

  const sentTo = [];
  for (const [g, its] of jobs) {
    /* 同一个群一轮的多条合成一条发：她有时连发五六句，逐条发会把群刷满。
       每条自带 `[HH:mm:ss] 昵称…` 头，直接空行拼接就行。 */
    /* 图片条目 text 为空（只有 img），拼文本时跳过，别拼出一堆空行 */
    const texts = its.map((x) => String(x.text || '')).filter((t) => t.trim());
    const imgs = its.map((x) => String(x.img || '').trim()).filter(Boolean);
    const text = (texts.length === 1 ? texts[0]
      : texts.join('\n\n')).slice(0, 1700);

    /* 🔴 测试/自检文案**永远不进群**（站长 2026-11-12：「这个出现在哪几个群就不要一起发了 不太好哈」）。
       守卫只认【自检】/【测试】/通道自检/推送通道测试 这几种固定写法，
       她正常发言里出现「测试」两个字（如「测试一下直播」）不会被误拦。
       要验证推送，跑 `node wxbot/agent-wechat-bridge.mjs --dry`（只记不发）。 */
    if (text && /(?:【\s*(?:自检|测试)[^】]*】|通道自检|推送通道测试|推送通道自检)/.test(text)) {
      log('拦下测试文案，未发群：' + text.replace(/\s+/g, ' ').slice(0, 50));
      continue;
    }

    let ok = true;
    if (text) {
      /* 日志带上首行摘要：以前只打「[推送] N 条 15:31」，事后根本分不清
         推的是房间消息还是上下线播报（2026-11-12 排查「上线没推到群」时吃过这个亏）。 */
      const brief = String(texts[0] || '').replace(/\s+/g, ' ').slice(0, 26);
      /* 标签按「本批里到底有几条是上下线」算。原来直接对整个 text 做 /[💡🕑]/，
         只要一批里混了一条上下线，整批都会被标成 [上下线]，看不出混发。 */
      const onOffN = its.filter((x) => /^[💡🕑]/.test(String(x.text || '').trim())).length;
      const tag = !onOffN ? '推送' : onOffN === its.length ? '上下线' : `推送+上下线${onOffN}`;
      ok = await say(g, text, `[${tag}] ${its.length} 条 ${bjHM(its[its.length - 1].t)} ${brief}`);
      if (!ok) log(`推送失败，已放弃这一批（${g}）`);
    }
    /* 文本之后逐张补发真图；一张失败不影响其余 */
    for (const im of imgs) {
      const gi = await sayImage(g, im);
      if (!gi) log(`图片没发出去（${g}）`);
      await sleep(600);
    }
    if (ok) sentTo.push(g);
    await sleep(1200);   // 别让 daemon 撞车（同时受理一个 send）
  }
  log(`推送完成 ${fresh.length} 条 → ${sentTo.length}/${jobs.size} 群`);
}

/** 长轮询：每 PUSH_EVERY 秒一次，永不退出；单次异常只记日志，不影响下一条 */
async function pump() {
  const desc = PUSH_MAP.size
    ? [...PUSH_MAP.entries()].map(([g, ws]) => g + '←' + (ws.join('|') || '全部')).join('，')
    : (PUSH_GROUPS.join(',') || '关（没配 WX_PUSH_GROUPS / WX_PUSH_MAP）');
  log(`推送通道：${desc}，每 ${Math.round(PUSH_EVERY / 1000)} 秒取件`);
  if (!PUSH_MAP.size && !PUSH_GROUPS.length) return;
  for (;;) {
    try {
      /* 🔴 硬超时兜底：pullOnce 里只要有一次 `wx` 调用卡住，整个取件循环就永久停摆，
         队列里的推送会一直躺着（2026-11-12 实测：16:00 的下线播报在队列里躺了
         90 分钟，直到手动重启桥才发出去 —— 表现就是站长说的「推送到群里丢失了」）。
         这里 race 一个 90 秒上限，卡住就抛错、下一轮重新取件。 */
      await Promise.race([
        pullOnce(),
        sleep(90e3).then(() => { throw new Error('取件超时 90s，重开一轮'); }),
      ]);
    } catch (e) { log('取件异常：' + (e && e.message)); }
    await sleep(PUSH_EVERY);
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

  p.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line[0] !== '{') continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind !== 'message.committed') continue;
      chain = chain.then(() => handle(ev)).catch((e) => log('处理异常：' + (e && e.message)));
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
else { pump(); watch(); }
