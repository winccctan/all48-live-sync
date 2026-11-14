/**
 * 星光播报 · 安卓发送端（AutoJS6）
 * =================================
 * 干的事：每 20 秒问一次云端队列（Cloudflare Worker），
 *        有消息就用无障碍操作微信，发到指定群里。
 *
 * 装什么：AutoJS6（开源免费，包名 org.autojs.autojs6）
 * 开什么：① 无障碍服务 ② 电池优化白名单（否则后台会被系统杀掉）
 *        ③ 开发者选项里「充电时屏幕不休眠」（息屏时无障碍点不动）
 *
 * 🔴 用法：改下面 CFG 的 host/qp/key/room → 右上角 ▶ 运行 → 回到桌面放着别动。
 *    日志在这个脚本的「日志」页里看，出问题先看最后 20 行。
 */

const CFG = {
  /* 取件服务端。两种都行：
     ① 云端队列（推荐，不依赖任何电脑常开）：host 填 Worker 域名，qp = '/api/wxq'
     ② 本机取件口（调试用）：host 填 http://192.168.x.x:8789，qp = '/q' */
  host: 'https://all48-archive.yqz-tansy.workers.dev',
  qp: '/api/wxq',

  /* 取件口令，要和 Worker 的 WX_QUEUE_TOKEN 一字不差 */
  key: 'REPLACE_ME',

  /* 发到哪个群。先精确匹配，匹配不到再用「包含」匹配。
     ⚠️ 必须和微信里显示的群名一致（带不带括号都算，别少了空格） */
  room: '追光小站',

  /* 多久问一次（毫秒）。20 秒够用，别调太小 */
  interval: 20000,

  /* 群指令（LG?成员名 这类）。手机只负责读群消息和打字，答案由服务端算。
     🔴 查询走 CFG.host 的 /api/cmd（主站转发给 lv 站），**不要直连 all48-lv 那个子域**：
        同一台手机到 all48-archive 每 20 秒都通，到 all48-lv 却一直超时（2026-11-12 实测），
        表现就是指令永远没回复、状态卡在 cmd-nX-cY 不动。 */
  lv: '',                  // 已废弃：改走 host + '/api/cmd'
  cmdk: 'REPLACE_ME',
  /* 每几轮读一次群指令。1 = 每轮都读（脚本常驻在群页面里，读一次几乎不花钱） */
  cmdEvery: 1,
};

/* ------------------------------------------------------------------ */

const VER = 'v12-lg8';
const WX_PKG = 'com.tencent.mm';
let lastSeenT = 0;          // 防止同一条被发两次
let failStreak = 0;
/** 上一轮走到哪一步。随取件一起报给 Mac（&s=），Mac 端状态变化时打日志，
 *  这样不用在手机上翻来翻去截图，Mac 那边就能看到卡在哪 */
let lastState = 'boot';

function log2(s) { log(new Date().toTimeString().slice(0, 8) + ' ' + s); }

/* 界面文字一律给多语言候选 —— 这台是日版 ARROWS，系统语言日文时微信会跟着变日文界面，
   硬写「通讯录」「发送」会一个都匹配不上 */
const T = {
  contacts: ['通讯录', '連絡先', 'Contacts'],
  discover: ['发现', '発見', 'Discover'],
  me: ['我', 'マイページ', 'Me'],
  chats: ['微信', 'WeChat', 'チャット', 'Chats'],
  search: ['搜索', '検索', 'Search'],
  send: ['发送', '送信', 'Send'],
  cancel: ['取消', 'キャンセル', 'Cancel'],
};

/** 依次找，返回第一个存在的节点（都没有返回 null） */
function pick(words) {
  for (let i = 0; i < words.length; i++) {
    const n = text(words[i]).findOnce() || desc(words[i]).findOnce();
    if (n) return n;
  }
  return null;
}

function hasWord(words) {
  for (let i = 0; i < words.length; i++) {
    if (text(words[i]).exists() || desc(words[i]).exists()) return true;
  }
  return false;
}

/* 取件 */
function pull() {
  try {
    const r = http.get(CFG.host + CFG.qp + '?k=' + encodeURIComponent(CFG.key)
      + '&s=' + encodeURIComponent(VER + '|' + lastState), { timeout: 10000 });
    if (r.statusCode !== 200) {
      log2('取件 HTTP ' + r.statusCode + (r.statusCode === 403 ? '（口令不对）' : ''));
      lastState = 'pull-http-' + r.statusCode;
      return [];
    }
    const j = r.body.json();
    return (j && j.items) || [];
  } catch (e) {
    failStreak++;
    lastState = 'pull-fail:' + String(e).slice(0, 40);
    if (failStreak % 5 === 1) log2('取件失败：' + e + '（看下手机能不能上网）');
    return [];
  }
}

/** 息屏时无障碍点不动、微信拉起来也在锁屏后面 —— 先点亮（无密码锁时上滑解锁） */
function wakeScreen() {
  try {
    if (device.isScreenOn && device.isScreenOn()) return;
    log2('屏幕是黑的，先唤醒');
    device.wakeUp();
    sleep(700);
    swipe(device.width / 2, device.height * 0.8, device.width / 2, device.height * 0.3, 300);
    sleep(900);
  } catch (e) { log2('唤醒失败：' + e); }
}

/** 拉起微信：app.launch 失败就换 intent 再试一次，并把结果写进日志。
 *  🔴 安卓 10+ 「后台启动界面」受限：AutoJS6 必须有「显示在其他应用的上层」权限，
 *     否则人在桌面上时脚本拉起微信会被系统静默拦掉（日志只有一句 false）。
 *
 *  🔴 顺序很关键：先点名 LauncherUI（微信主界面的 Activity）。
 *     app.launch 会把「上次停留的页面」原样恢复 —— 如果上次停在搜索页/某篇文章，
 *     起来之后就没有底栏，于是什么都匹配不到（这正是之前一直失败的原因之一）。 */
function launchWx() {
  wakeScreen();
  try {
    const ok = app.startActivity({ packageName: WX_PKG, className: 'com.tencent.mm.ui.LauncherUI' });
    if (ok) { log2('拉起微信：LauncherUI'); return true; }
  } catch (e) { log2('LauncherUI 不行：' + String(e).slice(0, 40)); }
  try {
    const ok = app.launch(WX_PKG);
    log2('拉起微信：' + ok);
    if (ok) return true;
  } catch (e) { log2('app.launch 出错：' + e); }
  try {
    app.startActivity({ packageName: WX_PKG });
    log2('app.launch 失败，改用 intent 拉了一次');
    return true;
  } catch (e2) { log2('intent 也失败：' + e2); lastState = 'launch-fail'; }
  return false;
}

/* 确保微信在前台。
 * 🔴 这是整个脚本最重要的一道闸：任何一步点错退出了微信，后面的 setText
 *    就会写到「桌面搜索」里去（站长遇到的就是这个：退回桌面后搜起了「游戏群」）。 */
function waitFg(sec) {
  const n = Math.round((sec || 15) * 2);
  for (let i = 0; i < n; i++) {
    if (currentPackage() === WX_PKG) return true;
    sleep(500);
  }
  return false;
}

function ensureWx() {
  if (currentPackage() === WX_PKG) return true;
  launchWx();
  if (!waitFg(15)) { lastState = 'not-foreground'; return false; }
  sleep(600);
  return true;
}

/** 当前 Activity 名（无障碍读不到文字时的唯一可靠依据） */
function act() {
  try { return currentActivity() || ''; } catch (e) { return ''; }
}

/** 标题栏上有没有「返回」。微信里所有二级页（聊天/设置/详情）都有，主界面没有。 */
function hasBackBtn() {
  const w = ['返回', 'Back', '戻る'];
  for (let i = 0; i < w.length; i++) {
    try { if (desc(w[i]).exists() || text(w[i]).exists()) return true; } catch (e) { }
  }
  return false;
}

/** 顶部标题栏最上面那条文字（聊天页就是群名/昵称） */
function titleText() {
  let best = '', by = 1e9;
  try {
    const ns = className('android.widget.TextView').find();
    for (let i = 0; i < ns.length; i++) {
      const b = ns[i].bounds();
      if (b.centerY() > device.height * 0.13) continue;
      const t = String(ns[i].text() || '').trim();
      if (!t) continue;
      if (b.centerY() < by) { by = b.centerY(); best = t; }
    }
  } catch (e) { }
  return best;
}

/** 是不是微信主界面。
 *  🔴 2026-11-12 大修：**微信 8.0.x 所有页面 Activity 都叫 LauncherUI**（聊天页、设置页都是），
 *     原来「Activity 是 LauncherUI 就当主界面」这条兜底是毒药 ——
 *     手机明明停在群里，脚本却认为自己在列表，于是后面所有点击都打在群聊页上，
 *     一路走到搜索再报 no-searchpage。站长的原话「我看手机里面在群里面啊」就是这个。
 *     ⇒ 判据改成「底栏四个标签至少数够 3 个」，主界面 4 个都在，其它页面基本 0~1 个。 */
function isList() {
  let n = 0;
  if (hasWord(T.chats)) n++;
  if (hasWord(T.contacts)) n++;
  if (hasWord(T.discover)) n++;
  if (hasWord(T.me)) n++;
  if (n >= 3) return true;
  if (inChat()) return false;            // 有底部输入框 ⇒ 聊天页
  if (hasBackBtn()) return false;        // 有返回 ⇒ 二级页（设置/详情/搜索）
  const a = act();
  return /LauncherUI/i.test(a) && n >= 2; // 读不全时放宽一档，但仍要求两个标签
}

/** 已经在「目标群」的聊天页里：有输入框 + 顶部标题就是群名。
 *  上一轮没退出去时直接用，别 back 来 back 去（现在就是这样卡住的）。 */
function inRoom(want) {
  if (!inChat()) return false;
  let t = '';
  try { t = titleText(); } catch (e) { }
  return !!t && t.indexOf(want) >= 0;
}

/** 是不是微信的搜索页：顶部有输入框、但没有底部标签栏 */
function isSearchPage() {
  const a = act();
  if (/FTSMainUI|\.fts\.|Search/i.test(a)) return true;
  /* 🔴 2026-11-12 增补：已经不在主界面也不在聊天页 ⇒ 那就是进了搜索页。
     大陆版微信 8.0.x 点顶部搜索会换 Activity，但名字不一定是 FTSMainUI，
     光靠上面那条正则匹配不上（这就是手机报 no-searchpage 的一半原因）。
     放宽到这一条是安全的：后面必须真的进到 ChattingUI 才会发消息。 */
  if (a && !/LauncherUI|ChattingUI/i.test(a)) return true;
  const es = className('android.widget.EditText').find();
  let top = null;
  for (let i = 0; i < es.length; i++) {
    if (es[i].bounds().centerY() < device.height * 0.25) { top = es[i]; break; }
  }
  if (!top) return false;
  /* 🔴 另一半原因：搜索页是「盖」在主界面上的，底栏文字往往还留在无障碍树里，
     所以原来那句 `return !isList()` 会把真搜索页判成主界面 ⇒ 永远失败。
     现在先看输入框有没有拿到焦点、再看顶部有没有「取消」。 */
  try { if (top.isFocused && top.isFocused()) return true; } catch (e) { }
  if (hasWord(T.cancel)) return true;
  return !isList();
}

/** 点底栏的某个标签（用 y 坐标落在屏幕最底部来认，避免点到聊天列表里的同名文字） */
function tapTab(words) {
  for (let i = 0; i < words.length; i++) {
    const ns = text(words[i]).find();
    for (let j = 0; j < ns.length; j++) {
      const b = ns[j].bounds();
      if (b.centerY() > device.height * 0.85) { click(b.centerX(), b.centerY()); return true; }
    }
  }
  return false;
}

/* 把当前屏幕上的文字打到日志里 —— 卡住时看这一行就知道微信停在哪一页 */
function dumpUi(tag) {
  try {
    const ns = className('android.widget.TextView').find();
    const arr = [];
    for (let i = 0; i < ns.length && arr.length < 24; i++) {
      const s = (ns[i].text() || ns[i].desc() || '').trim();
      if (s) arr.push(s + '@' + Math.round(ns[i].bounds().centerY()));
    }
    const aa = act() || '?';
    log2('[' + tag + '] 文字节点 ' + ns.length + ' 个，Activity=' + aa);
    log2('[' + tag + '] ' + (arr.join(' | ') || '(屏上没读到文字)'));
  } catch (e) { log2('[' + tag + '] 读取失败：' + e); }
}

/** 当前屏上 TextView 节点数（-1 = 查询本身报错） */
function countTv() {
  try { return className('android.widget.TextView').find().length; } catch (e) { return -1; }
}

/* 确保微信在聊天列表 */
function toChatList() {
  wakeScreen();
  if (!ensureWx()) { log2('微信没进前台（被系统拦了？看「显示在其他应用上层」权限）'); return false; }

  /* 这台 ARROWS 微信冷启动要好几秒，启动图期间屏上啥都没有。
     所以前 5 轮（约 6 秒）只等不动作，避免把「还在加载」误判成「进错页」然后 back 掉微信。 */
  for (let i = 0; i < 14; i++) {
    if (!ensureWx()) return false;                        // 中途被挤后台就重新拉起，绝不在桌面瞎点
    if (isList()) return true;
    if (inChat()) { back(); sleep(900); continue; }        // 在聊天页：back 一次必然回到列表
    if (i < 5) { sleep(1200); continue; }
    if (isSearchPage()) { back(); sleep(800); continue; }  // 卡在搜索页：先退掉
    back(); sleep(800);                                     // 停在别的二级页（设置/文章）→ 退一层
  }
  log2('兜底：点底栏「WeChat/微信」回列表');
  tapTab(T.chats);
  sleep(1200);
  if (!ensureWx()) return false;
  if (isList()) return true;

  log2('没等到微信主界面');
  dumpUi('界面');
  lastState = 'no-wxlist';
  return false;
}

/** 是不是在聊天页：看有没有「底部」的输入框。
 *  列表页顶部那个搜索框也是 EditText，靠位置区分（>60% 高度才算聊天页的） */
function inChat() {
  const a = act();
  if (/ChattingUI|Chatting/.test(a)) return true;
  const es = className('android.widget.EditText').find();
  for (let i = 0; i < es.length; i++) {
    if (es[i].bounds().centerY() > device.height * 0.6) return true;
  }
  return false;
}

/** 找顶部搜索入口。按可靠性依次尝试：
 *  ① 文字/描述的「搜索」  ② 顶部 EditText
 *  ③ 顶部那条「可点击的宽容器」——微信搜索栏就是个 clickable 的 Layout，
 *     读不到任何文字时这一条才是唯一出路（v7 之前直接猜坐标，点偏了就全灭）
 *  返回节点，调用方用坐标去点（容器节点 .click() 常常不生效）。 */
function findSearch() {
  const s = pick(T.search);
  if (s) return s;
  const es = className('android.widget.EditText').find();
  for (let i = 0; i < es.length; i++) {
    if (es[i].bounds().centerY() < device.height * 0.25) return es[i];
  }
  let sb = 0;
  try { sb = device.getStatusBarHeight() || 0; } catch (e) { sb = 0; }
  const cs = clickable(true).find();
  let best = null, bestScore = -1;
  for (let i = 0; i < cs.length; i++) {
    const b = cs[i].bounds();
    const cy = b.centerY();
    if (cy < Math.max(sb, device.height * 0.03)) continue;   // 别点状态栏
    if (cy > device.height * 0.20) continue;                  // 只看顶部区
    if (b.width() < device.width * 0.45) continue;            // 搜索栏很宽
    const score = b.width() * 1000 - Math.abs(cy - (sb + device.height * 0.035));
    if (score > bestScore) { bestScore = score; best = cs[i]; }
  }
  return best;
}

/** 点搜索入口。统一走坐标（节点 click 对容器常常无效） */
function tapSearch() {
  const n = findSearch();
  if (!n) return 0;
  const b = n.bounds();
  const x = Math.round(b.centerX()), y = Math.round(b.centerY());
  click(x, y);
  return y;
}

/** 等搜索页出来（点完有动画，1.4 秒常常不够；轮询到 3 秒） */
function waitSearchPage() {
  for (let i = 0; i < 8; i++) {
    if (isSearchPage()) return true;
    sleep(400);
  }
  return false;
}

/* 兜底进群：不看群名，直接点会话列表最上面那一项，进去再校验顶部标题。
 * 🔴 为什么需要：群被别的聊天挤下去之后，`textContains(群名)` 找不到，
 *    就只能走搜索；而搜索在有些版本里点不开（回执 no-searchpage:LauncherUI）。
 *    刚聊过的群一定在列表顶部，所以按位置点是同一件事的更稳版本。
 * 🔴 必须校验标题 —— 点错就是往别人的私聊里发播报，比发不出去严重得多。 */
function openFirstChat(want) {
  const H = device.height, W = device.width;
  for (let k = 0; k < 3; k++) {
    if (!isList()) return false;
    const y = Math.round(H * (0.155 + k * 0.078));   // 第 1/2/3 项
    log2('兜底：点会话列表第 ' + (k + 1) + ' 项 y=' + y);
    click(Math.round(W * 0.42), y);
    sleep(1900);
    if (!inChat()) { log2('第 ' + (k + 1) + ' 项没进聊天页'); continue; }
    const tt = titleText();
    if (tt && tt.indexOf(want) >= 0) { log2('进了正确的群：' + tt); return true; }
    log2('进错聊天（标题是「' + tt + '」，不含「' + want + '」），退回');
    back(); sleep(900);
  }
  return false;
}

/* 进群。返回 true = 已经在群里 */
function openRoom() {
  /* ⓿ 已经在目标群里（上一轮答完没退出去）→ 直接用。
     🔴 不先判这个的话，toChatList() 会把它 back 掉再重新进，白白多花 4 秒，
     而且中途任何一步读不准就整轮失败。 */
  if (inRoom(CFG.room)) { log2('已经在群里，直接用'); return true; }

  if (!toChatList()) { log2('进不到聊天列表'); return false; }

  // ① 直接在列表里看到（置顶/最近聊过的最省事）
  let item = text(CFG.room).findOnce();
  if (!item) {
    // 群名可能带未读数（游戏群(3)）或被截断，用「包含」再找一次；
    // 只认屏幕左侧的（列表项），避开聊天内容里的同名字样 —— 也**必须避开标题栏**，
    // 否则会去点标题栏（在聊天页点标题会打开群设置，越走越远）
    const cs = textContains(CFG.room).find();
    for (let i = 0; i < cs.length; i++) {
      const b = cs[i].bounds();
      if (b.centerX() < device.width * 0.6
        && b.centerY() > device.height * 0.13
        && b.centerY() < device.height * 0.85) { item = cs[i]; break; }
    }
  }
  if (item) {
    const b = item.bounds();
    if (b.centerY() > device.height * 0.13 && b.centerY() < device.height * 0.85) {
      log2('列表里就有，直接点');
      click(b.centerX(), b.centerY());
      sleep(2000);
      if (inRoom(CFG.room)) return true;
      if (inChat()) { log2('进了别的聊天，退回'); back(); sleep(900); }
      else log2('点列表项没进聊天页');
    }
  }

  // ①-b 兜底：群没在列表里露出来（被别的聊天挤下去）→ 按位置点最近会话，进去校验标题
  if (openFirstChat(CFG.room)) return true;

  // ② 走搜索
  if (!ensureWx()) return false;
  /* 🔴 这里必须走坐标点击（tapSearch），**不能用节点的 .click()**：
     微信主界面那条搜索栏读出来常常是一个 clickable 的 Layout 容器，
     对容器调 .click() 会返回 true 却毫无反应 —— 界面还停在主界面，
     于是下一步 isSearchPage() 判 false，手机就一直报 no-searchpage。
     这正是 2026-11-12 一晚上发不出消息的真凶（tapSearch 早就写好了，却没人调用）。 */
  const sy = tapSearch();
  if (sy) log2('点搜索栏 y=' + sy);
  else {
    // 兜底：微信主界面顶部那条搜索栏，直接点它的位置（读不到任何节点时唯一出路）
    log2('没找到搜索节点，直接点顶部搜索条');
    click(Math.round(device.width * 0.5), Math.round(device.height * 0.072));
  }
  sleep(1400);
  waitSearchPage();

  // 🔴 必须确认进了微信自己的搜索页再打字，否则字会落到桌面/其它 App 的输入框里
  if (!ensureWx()) return false;
  if (!isSearchPage()) {
    log2('点了搜索但没进搜索页，中止（不乱打字）');
    dumpUi('点搜索后');
    // 把真实 Activity 带回去，下一轮就能看到卡在哪（只报 no-searchpage 没法定位）；
    // 顺带带上屏上前几条文字，下次「进不去」时一眼看出停在哪一页
    let smp = '';
    try {
      const ns = className('android.widget.TextView').find();
      const a2 = [];
      for (let i = 0; i < ns.length && a2.length < 4; i++) {
        const t = String(ns[i].text() || '').trim();
        if (t) a2.push(t.slice(0, 6));
      }
      smp = a2.join('/');
    } catch (e) { }
    lastState = 'no-searchpage:' + (act().split('.').pop() || '?') + (smp ? '#' + smp : '');
    return false;
  }

  const box = className('android.widget.EditText').findOnce();
  if (!box) { log2('搜索输入框没出来'); lastState = 'no-searchbox'; return false; }
  box.click();
  sleep(400);
  setText(CFG.room);
  sleep(1800);
  if (!ensureWx()) return false;

  // 结果里挑群：文本完全等于群名的优先；同名的取最下面那个
  // （顶部那行往往是「搜索 游戏群」的提示，点它只会再搜一次）
  function lowest(nodes) {
    let best = nodes[0], by = best.bounds().centerY();
    for (let i = 1; i < nodes.length; i++) {
      const y = nodes[i].bounds().centerY();
      if (y > by) { best = nodes[i]; by = y; }
    }
    return best;
  }
  let hit = null;
  const exact = text(CFG.room).find();
  if (exact && exact.length) hit = lowest(exact);
  if (!hit) {
    const loose = textContains(CFG.room).find();
    if (loose && loose.length) hit = lowest(loose);
  }
  if (!hit) { log2('搜不到群「' + CFG.room + '」'); lastState = 'no-room'; back(); return false; }
  const hb = hit.bounds();
  log2('点搜索结果：' + (hit.text() || '(无名)') + '  y=' + Math.round(hb.centerY()));
  click(hb.centerX(), hb.centerY());
  sleep(2000);

  // 点了必须真的进到聊天页，否则别往下发（发到别处更糟）
  if (!inChat()) { log2('点了但没进聊天页'); dumpUi('点结果后'); lastState = 'no-chatpage'; return false; }
  return true;
}

/* 在群里说一句话 */
/** 收键盘。常驻群里之后键盘会一直挡着半个屏幕，下面那些消息就读不到了。
 *  🔴 不能用 back() —— 微信聊天页按 back 是退回会话列表，等于把脚本踢出群 */
function hideKb() {
  try {
    const im = context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE);
    im.hideSoftInputFromWindow(activity.getWindow().getDecorView().getWindowToken(), 0);
  } catch (e) { }
}

function say(msg) {
  if (!ensureWx()) return false;
  const box = className('android.widget.EditText').findOne(3000);
  if (!box) { log2('聊天输入框没出现'); lastState = 'no-input'; return false; }
  box.click();
  sleep(300);
  setText(msg);
  sleep(400);

  const btn = pick(T.send);
  if (btn) { btn.click(); }
  else {
    log2('没找到发送按钮，试回车');
    press('enter', 1);
  }
  sleep(700);

  // 发出去的话输入框会清空；没清空说明没点上
  let sent = true;
  try {
    const left = className('android.widget.EditText').findOne(1000);
    if (left && String(left.text() || '').trim()) {
      log2('输入框还有字，可能没发出去');
      lastState = 'not-sent';
      sent = false;
    }
  } catch (e) { }
  if (sent) hideKb();          // 收键盘，别挡住下面要读的消息
  return sent;
}

let retry = [];             // 发失败的先攒着，下一轮再试（失败就丢消息很难受）
function handle(items) {
  const list = retry.concat((items || []).map(function (x) { return { t: x.t, text: x.text, _new: true }; }));
  retry = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || !it.text) continue;
    if (it._new && it.t && it.t <= lastSeenT) continue;   // 新取的才判重，重试项直接发

    log2('要发：' + it.text.split('\n')[0]);
    const ok = openRoom() && say(it.text);
    if (ok) {
      lastSeenT = Math.max(lastSeenT, it.t || Date.now());
      lastState = 'sent';
      log2('发出了');
    } else {
      it._n = (it._n || 0) + 1;
      if (it._n < 4) { retry.push(it); log2('失败，第 ' + it._n + ' 次，稍后重试'); }
      else log2('试了 3 次都不行，放弃这条');
    }
    /* 🔴 发完**不退群**：脚本常驻在群页面里（站长 2026-11-12：她就该一直在群里不出来），
       下一轮读指令、发播报都不用重新进群，也省掉一次次「退出→回列表→再进」的失败机会 */
    sleep(500);
  }
}

/* ---------------- 群指令（2026-11-12） ----------------
 * 手机只干两件事：把群里以 LG 开头的消息读出来、把服务端算好的答案打回去。
 * 口径/文案全在服务端 /api/wxcmd，改文案不用重装脚本。
 * 目前一条：LG?成员名  → 今日 / 近 7 天鸡腿，房间与直播分开。
 */
const cmdSeen = {};          // 指令原文 → 上次**答成功**的时间（5 分钟内不重复答）
const cmdTry = {};           // 指令原文 → 上次尝试时间（失败只冷却 45 秒，不是 5 分钟）

/** 读当前聊天页可见的消息文字。
 *  只取正文区域（去掉顶部标题栏和底部输入区），否则「发送」这类 UI 文字也会进来 */
function readMsgs() {
  const out = [];
  let ns;
  try { ns = className('android.widget.TextView').find(); } catch (e) { return out; }
  const top = device.height * 0.10, bot = device.height * 0.88;
  for (let i = 0; i < ns.length; i++) {
    let b;
    try { b = ns[i].bounds(); } catch (e) { continue; }
    const y = b.centerY();
    if (y < top || y > bot) continue;
    const s = String(ns[i].text() || '').trim();
    if (s) out.push(s);
  }
  return out;
}

/** 从屏上文字里挑出指令：LG?xxx / lg xxx / 鸡腿?xxx
 *  🔴 三个都要容忍，否则群里 @ 一下机器人就认不出来了：
 *    ① 前面带 `@星光播报 ` 前缀（微信 @ 后面常跟 U+2005 四分之一空格）
 *    ② 全角字母数字（中文输入法「全角」开着时 ＬＧ 就是全角）
 *    ③ 问号全半角、逗号顿号句号都算分隔符 */
function pickCmds(arr) {
  const got = [];
  const re = /^(?:@[^\s\u2005]*[\s\u2005]*)?(?:lg|鸡腿)[\s\u2005]*[?？:：,，.。、!！]?[\s\u2005]*\S/i;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (s.length > 60) continue;        // 长段落肯定不是指令
    // 全角 → 半角只用来做判定，发给服务端的还是原文
    const n = s.replace(/[\uFF01-\uFF5E]/g,
      function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
    if (!re.test(n)) continue;
    if (got.indexOf(s) < 0) got.push(s);
  }
  return got;
}

/** 问服务端要答案，返回要发回群里的文字（拿不到返回空串）
 *  🔴 超时必须短：手机在国内，走 workers.dev 偶尔会卡。
 *     以前写 15 秒 × 两条指令 = 主循环卡死 30 秒，回执都不更新，看着像脚本崩了。 */
function askCmd(q) {
  try {
    const r = http.get(CFG.host + '/api/cmd?k=' + encodeURIComponent(CFG.cmdk)
      + '&q=' + encodeURIComponent(q), { timeout: 6000 });
    if (r.statusCode !== 200) { log2('指令 HTTP ' + r.statusCode); return ''; }
    const j = r.body.json();
    return (j && j.reply) || '';
  } catch (e) { log2('指令请求失败：' + e); return ''; }
}

/** 一轮：进群 → 读指令 → 逐条答。返回答了几条（-1 = 进不去群）
 *  🔴 读完**不退群**：停在这个群里，下一轮的 openRoom() 会被 inRoom() 直接命中，
 *     省掉「退出→回列表→再进群」那 4~5 秒，也少一大截失败机会。
 *     （每 60 秒进出一次微信，屏幕上闪得很难看，还老是踩到列表滚动位置不对。） */
function runCmds() {
  if (!openRoom()) return -1;
  const arr = readMsgs();
  const list = pickCmds(arr);
  lastState = 'cmd-n' + arr.length + '-c' + list.length;

  const now = Date.now();
  for (var k in cmdSeen) if (now - cmdSeen[k] > 1800000) delete cmdSeen[k];   // 清老记录

  if (!list.length) {
    log2('群里没有指令（读到 ' + arr.length + ' 条文字）');
    return 0;
  }

  let done = 0;
  for (let i = 0; i < list.length; i++) {
    const q = list[i];
    /* 20 分钟内不重复答同一句：常驻群里之后，用户那句指令会一直留在屏幕上，
       窗口太短就变成每隔几分钟自己答一遍，很吵。 */
    if (cmdSeen[q] && now - cmdSeen[q] < 1200000) continue;
    /* 🔴 拿不到答案**绝不能**记成「已答」。
       以前就是这样：一次网络抖动 → 记 5 分钟 → 用户看到「发了没反应」，
       还得等五分钟。现在只做 45 秒短冷却，下一轮接着试。 */
    if (cmdTry[q] && now - cmdTry[q] < 45000) continue;
    cmdTry[q] = now;
    lastState = 'cmd-ask' + i;              // 卡在请求上时，回执会停在这个状态
    const ans = askCmd(q);
    if (!ans) {
      lastState = 'cmd-n' + arr.length + '-c' + list.length + '-e' + i;
      log2('「' + q + '」没拿到答案（45 秒后重试）');
      continue;
    }
    cmdSeen[q] = now;
    log2('答指令：' + q);
    if (say(ans)) {
      done++;
      lastState = 'cmd-ok' + done;
    }
    sleep(700);
  }
  return done;
}

/* ---------------- 启动 ---------------- */
if (!auto.service) {
  toast('请先开启无障碍服务');
  auto.waitFor();
}
if (!CFG.key || CFG.key === 'REPLACE_ME') {
  toast('先把 CFG.key 改成 Mac 上的 WX_QUEUE_TOKEN');
  log2('口令没填，退出');
  exit();
}

device.keepScreenOn(3600 * 1000);
log2('===== ' + VER + ' =====');
log2('开始，群：' + CFG.room + '，取件口：' + CFG.host);
log2('无障碍：' + auto.service + '  屏幕：' + device.width + 'x' + device.height
  + '  微信：' + (app.getPackageName(WX_PKG) || '没找到，包名不对？'));
try { log2('auto 模式：' + (auto.getMode ? auto.getMode() : '未知')); } catch (e) { }
/* 网络全局超时：手机在国内走 workers.dev，偶尔会挂住。
   不设这个的话，一次挂住就能把整个主循环堵死几十秒（回执都不更新，看着像崩了）。 */
try { http.setTimeout(6000); } catch (e) { log2('http.setTimeout 不可用：' + e); }
lastState = 'boot:a' + (auto.service ? 1 : 0);
toast('星光播报已启动');

/* 启动自检：**只测当前页面**，不 home() 也不重启微信。
 *  🔴 老版本那套（home → 数桌面节点 → 重启微信 → 数微信节点 → 切 fast 模式）
 *     是排查「无障碍被微信屏蔽」时的一次性体检，早就确认能读了。
 *     每次启动都跑一遍会把用户正在看的页面踢掉（站长 2026-11-12：手机明明停在群里，
 *     脚本一起就把人赶走，还以为自己进不去群）。
 *  现在只在微信不在前台时才拉起，其余什么都不动。
 *  状态形如 diag-wx-n24-ChattingUI → w=微信在前台 n=当前节点数 */
try {
  let cur = '';
  try { cur = currentPackage() || ''; } catch (e) { }
  let tv = countTv();
  log2('自检：前台 ' + (cur || '?') + '，文字节点 ' + tv);
  if (cur !== WX_PKG) {
    log2('自检：微信不在前台，拉起');
    launchWx();
    if (waitFg(15)) { sleep(2500); tv = countTv(); }
    else log2('自检：15 秒内微信没进前台（后台启动被系统拦了）');
  }
  lastState = 'diag-' + (cur === WX_PKG ? 'wx' : 'other') + '-n' + tv
    + '-' + (act().split('.').pop() || '?');
} catch (e) { log2('自检出错：' + e); lastState = 'diagerr-' + String(e).slice(0, 40); }

let loopN = 0;
let cmdFail = 0;
while (true) {
  try {
    loopN++;
    const items = pull();
    handle(items);
    /* 群指令：手上没有待发、也没有待重试的消息时才去读群，
       免得「答指令」把播报挤在后面排队 */
    if ((!items || !items.length) && !retry.length && loopN % CFG.cmdEvery === 0) {
      const r = runCmds();
      if (r < 0) {
        /* 进不去群 → 下一轮立刻再试（最多连试 3 次），否则一条指令要等一分钟 */
        cmdFail++;
        if (cmdFail <= 3) loopN = CFG.cmdEvery - 1;
        else log2('连续 ' + cmdFail + ' 次进不去群，先等等');
      } else cmdFail = 0;
    }
  } catch (e) {
    log2('异常：' + e);
  }
  sleep(CFG.interval);
}
