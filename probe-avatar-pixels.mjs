/**
 * 头像「图片内容」变化探针（只读，脱敏）
 * =====================================================
 * 上一轮 probe-avatar-signal.mjs 只比了 URL 字符串 hash —— 那测不出
 * 「CDN 固定地址、图片被原地替换」的情况。这一轮直接下载同一成员头像
 * 两次（隔一段可配间隔），对图片【字节/像素】做 hash，看会不会变。
 *
 * 🔴 脱敏：只打印成员序号、图片字节长度、md5 前 8 位；绝不打印图片 URL、uid、姓名。
 *
 * 运行：
 *   node probe-avatar-pixels.mjs                  # 下载一批头像，隔 45s 再下一次，比对
 *   node probe-avatar-pixels.mjs --gap 60 --n 8   # 隔 60s，取 8 个成员头像
 *   node probe-avatar-pixels.mjs --save /tmp/av   # 顺手把两轮图存盘（方便肉眼确认是不是同一张）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const API_BASE = 'https://pocketapi.48.cn';
let PA = '';
async function pocketCurl(path, body, token) {
  const { generatePa } = await import('./lib/pa.mjs');
  PA = PA || generatePa();
  const appInfo = JSON.stringify({
    vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
    appVersion: '7.0.41', appBuild: '24011601',
    osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
  });
  const { stdout } = await run('curl', [
    '-sS', '--noproxy', '*', '-m', '20', '-X', 'POST', API_BASE + path,
    '-H', 'Content-Type: application/json;charset=utf-8',
    '-H', 'appInfo: ' + appInfo,
    '-H', 'token: ' + token,
    '-H', 'pa: ' + PA,
    '-H', 'User-Agent: PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
    '-H', 'Accept-Language: zh-Hans-CN;q=1',
    '-d', JSON.stringify(body || {}),
  ], { maxBuffer: 8e6 });
  return JSON.parse(stdout);
}

/** 下载图片字节（走 curl 直连，不打日志、不落 URL） */
async function fetchImage(url) {
  const { stdout } = await run('curl', ['-sS', '--noproxy', '*', '-m', '20', '-L', url], {
    encoding: 'buffer', maxBuffer: 4e6,
  });
  return Buffer.from(stdout);
}

const ROOT = new URL('.', import.meta.url).pathname;
const env = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const pick = (t, k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(t || '')?.[1] || '').trim();
const TOKEN = process.env.POCKET48_TOKEN
  || pick(env(ROOT + 'nim-sync.env'), 'POCKET48_TOKEN')
  || pick(env(ROOT + 'fb.env'), 'POCKET48_TOKEN');
if (!TOKEN) { console.error('缺 POCKET48_TOKEN'); process.exit(1); }

const ARGS = process.argv.slice(2);
const opt = (k, d) => { const i = ARGS.indexOf('--' + k); return i >= 0 ? ARGS[i + 1] : d; };
const GAP = Number(opt('gap', 45)) * 1000;
const N = Number(opt('n', 8));
const SAVE = opt('save', '');

/* 从全团资料抓 N 个成员头像 URL（去掉下标，只按成员顺序取） */
async function loadAvatarUrls() {
  const d = await pocketCurl('/user/api/v1/client/update/group_team_star', { version: 0 }, TOKEN);
  const content = d && d.content !== undefined ? d.content : d;
  const list = content && Array.isArray(content.starInfo) ? content.starInfo : [];
  const out = [];
  for (const m of list) {
    const u = m && typeof m.avatar === 'string' ? m.avatar : '';
    if (/^https?:\/\//i.test(u)) out.push(u);
    if (out.length >= N) break;
  }
  return out;
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex').slice(0, 8);

async function snapshot(tag, urls) {
  const rows = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const buf = await fetchImage(urls[i]);
      rows.push({ idx: i, bytes: buf.length, hash: md5(buf) });
      if (SAVE) {
        mkdirSync(SAVE, { recursive: true });
        const ext = /\.png$/i.test(urls[i]) ? 'png' : 'jpg';
        writeFileSync(`${SAVE}/r${tag}_m${String(i).padStart(2, '0')}.${ext}`, buf);
      }
    } catch (e) {
      rows.push({ idx: i, bytes: -1, hash: 'ERR:' + String(e.message).slice(0, 30) });
    }
  }
  return rows;
}

const cmp = (a, b) => {
  let same = 0, diff = 0, err = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i].hash.startsWith('ERR') || b[i].hash.startsWith('ERR')) { err++; continue; }
    if (a[i].hash === b[i].hash) same++; else diff++;
  }
  return { same, diff, err };
};

(async () => {
  console.log('头像「图片内容」变化探针（只读；只打印成员序号/字节/md5前8位，不打 URL/uid/姓名）');
  const urls = await loadAvatarUrls();
  if (!urls.length) { console.log('没抓到头像 URL'); process.exit(0); }
  console.log(`取到 ${urls.length} 个成员头像，先下第一轮…`);
  const r1 = await snapshot(1, urls);
  console.log('第1轮：', r1.map((r) => `#${r.idx} ${r.bytes}B/${r.hash}`).join('  '));

  console.log(`\n…隔 ${GAP / 1000}s 后下第二轮，比图片字节…`);
  await new Promise((s) => setTimeout(s, GAP));
  const r2 = await snapshot(2, urls);
  console.log('第2轮：', r2.map((r) => `#${r.idx} ${r.bytes}B/${r.hash}`).join('  '));

  const { same, diff, err } = cmp(r1, r2);
  console.log(`\n判读：图片内容完全相同 ${same} 个 / 变化 ${diff} 个 / 出错 ${err} 个`);
  if (diff === 0) {
    console.log('→ 两轮图片【字节完全一致】⇒ 这些成员在采样间隔内头像没变。');
    console.log('  注意：只有采样间隔内「恰好有成员上下线」才会看到变化；间隔太短可能碰巧没人变。');
    console.log('  想更有说服力：把 --gap 拉到 300~600s，或对准「刚看到有人上线」的时间点再比。');
  } else {
    console.log('→ ⚠️ 有成员头像图片变了！这是第一个非权限的在线信号，值得深挖。');
  }
  if (SAVE) console.log(`两轮图片已存 ${SAVE}/（r1_*=第一轮，r2_*=第二轮）`);
})();
