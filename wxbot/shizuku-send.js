/**
 * 星光播报 · Shizuku 版（AutoJS6）
 * =================================
 * 为什么不用无障碍：这台机装的是微信国际版（WeChat），它屏蔽了第三方无障碍 ——
 *   实测同一个时刻，系统桌面能读到 91 个文字节点，微信界面读到 0 个。
 *   所以 text()/desc()/setText 在微信里全部无效，那条路走不通。
 *
 * 改走 Shizuku（adb 权限），直接对系统下命令：
 *   input tap X Y          点屏幕坐标（不需要读节点）
 *   input keyevent 279     粘贴（配合 setClipboard 输入中文）
 *   screencap -p 文件      截图
 *   am start -n ...        拉起微信主界面
 *
 * 🔴 前置两件事（缺一不可）：
 *   ① 装 Shizuku，并「通过无线调试启动」服务
 *   ② AutoJS6 首页左侧抽屉 → 打开「Shizuku」开关（弹窗点允许）
 */

const CFG = {
  /* Mac 的局域网地址（live-notify.mjs 启动时会打出来） */
  host: 'http://192.168.0.231:8789',
  /* 取件口令，必须和 live-notify.env 里的 WX_QUEUE_TOKEN 一致 */
  key: 'REPLACE_ME',
  /* 发到哪个群 */
  room: '游戏群',
  /* 多久问一次（毫秒） */
  interval: 20000,
};

const VER = 's1-2321';
const WX = 'com.tencent.mm';

let lastState = 'boot';

function log2(s) { log(new Date().toTimeString().slice(0, 8) + ' ' + s); }

/* 执行一条 adb 命令。返回 stdout；失败返回 null */
function sh(cmd) {
  try {
    const r = shizuku(cmd);
    return r && r.result !== undefined ? String(r.result) : '';
  } catch (e) {
    log2('shizuku 出错：' + String(e).slice(0, 60));
    return null;
  }
}

/* 把状态报给 Mac（版本号一起带上，省得搞不清跑的是哪版） */
function report(state) {
  lastState = state;
  try {
    http.get(CFG.host + '/q?k=' + encodeURIComponent(CFG.key)
      + '&s=' + encodeURIComponent(VER + '|' + state), { timeout: 8000 });
  } catch (e) { }
}

/* 截屏 → 压到 540 宽 → jpg → POST 给 Mac。
   🔴 这是"眼睛"：微信读不到节点，只能靠看图确定点什么位置 */
function shot(tag) {
  const p = '/sdcard/wxshot.png';
  const r = sh('screencap -p ' + p);
  if (r === null) { log2('screencap 失败'); return false; }
  sleep(1200);
  let b64 = '';
  try {
    const img = images.read(p);
    if (!img) { log2('读不到截图文件'); return false; }
    const w = img.getWidth(), h = img.getHeight();
    const small = w > 540 ? images.resize(img, 540, Math.round(h * 540 / w)) : img;
    b64 = images.toBase64(small, 'jpg', 62);
  } catch (e) { log2('处理截图失败：' + String(e).slice(0, 60)); return false; }
  if (!b64) { log2('截图转 base64 是空的'); return false; }
  try {
    const res = http.postJson(CFG.host + '/shot?k=' + encodeURIComponent(CFG.key),
      { tag: tag, b64: b64 }, { timeout: 30000 });
    log2('截图已上传：' + tag + ' HTTP ' + (res ? res.statusCode : '?'));
    return true;
  } catch (e) { log2('上传失败：' + String(e).slice(0, 60)); return false; }
}

/* ---------------- 启动 ---------------- */
if (!CFG.key || CFG.key === 'REPLACE_ME') {
  toast('先把 CFG.key 改成 Mac 上的 WX_QUEUE_TOKEN');
  log2('口令没填，退出');
  exit();
}

device.keepScreenOn(3600 * 1000);
log2('===== ' + VER + ' =====');
log2('开始，群：' + CFG.room + '，取件口：' + CFG.host);

if (typeof shizuku !== 'function') {
  toast('AutoJS6 没开 Shizuku 权限');
  log2('shizuku 不可用 —— 去 AutoJS6 首页左侧抽屉打开「Shizuku」开关（会弹授权，点允许）');
  report('no-shizuku');
  exit();
}

const probe = sh('echo ok');
log2('shizuku 试跑结果：' + probe);
if (probe === null) {
  log2('shizuku 能引用但执行失败 —— 确认 Shizuku 服务已启动（App 里要显示"运行中"）');
  report('shizuku-dead');
  exit();
}
report('shizuku-ok');

/* 这一版只做一件事：拉起微信主界面并截一张图传回 Mac，
   等我（Mac 端）看清界面布局、量出坐标，再写真正的点击/输入流程 */
log2('拉起微信主界面');
sh('am start -n ' + WX + '/' + WX + '.ui.LauncherUI');
sleep(4500);
shot('wxlist');
report('shot-wxlist');

log2('本轮完成：截图已发到 Mac');
toast('截图已上传，去看 Mac');
