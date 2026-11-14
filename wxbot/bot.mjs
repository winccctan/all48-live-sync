#!/usr/bin/env node
/**
 * 个人微信号桥（给 live-notify.mjs 用）
 * =====================================
 * 为什么需要它：个人微信没有开放接口，想让「一个微信号」在群里自动说话，
 * 只能靠协议层 puppet（padlocal 是 iPad 协议）。这个进程负责：
 *   ① 扫码登录一个微信号（专门的小号，别用主号）
 *   ② 提供本地 HTTP 口：POST /push {"text":"..."} → 在指定群里发这条
 *   ③ live-notify.mjs 只管「什么时候该发」，发不发得出去由这里决定
 *
 * 🔴 风险提示（必须知道）：
 *   腾讯明确禁止第三方协议登录，风控是按行为打的。只用来「低频往一个群推通知」
 *   风险相对低，但不是零：号可能被限制登录、被要求人脸、极端情况封号。
 *   ⇒ 用小号、别群发、别加好友、别改资料。
 *
 * 配置（wxbot.env，已 gitignore）：
 *   WX_TOKEN=          padlocal 的 token（wechaty 官网申请，有免费试用）
 *   WX_ROOM=           群名关键字（能唯一匹配到就行，比如「王语晨」）
 *   PORT=8788          本地端口
 *
 * 用法：
 *   node bot.mjs            # 起服务（首次会打印二维码，用手机微信扫）
 *   node bot.mjs --rooms    # 只列出现在这个号在的所有群，用来填 WX_ROOM
 */
import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WechatyBuilder } from 'wechaty';
import qrcodeTerminal from 'qrcode-terminal';

const HERE = dirname(fileURLToPath(import.meta.url));
const envFile = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pickEnv = (txt, k) => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(txt);
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : '';
};
const ENV = envFile(resolve(HERE, 'wxbot.env'));
const E = (k, d = '') => process.env[k] || pickEnv(ENV, k) || d;

const TOKEN = E('WX_TOKEN');
const ROOM_Q = E('WX_ROOM');
const PORT = Number(E('PORT', '8788'));
const LIST_ONLY = process.argv.includes('--rooms');

if (!TOKEN) {
  console.error('[FATAL] 缺少 WX_TOKEN —— 去 https://wechaty.js.org/docs/puppet-providers/padlocal 申请（有免费试用）');
  process.exit(1);
}

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 19).replace('T', ' '), ...a);

/* ---------------- 微信 ---------------- */
const bot = WechatyBuilder.build({
  name: 'all48-wxbot',
  puppet: 'wechaty-puppet-padlocal',
  puppetOptions: { token: TOKEN },
});

let room = null;
let online = false;
let lastAt = 0;
let lastErr = '';

async function findRoom() {
  if (!ROOM_Q) return null;
  const all = await bot.Room.findAll();
  // 先精确、再包含，避免「王语晨」匹配到「王语晨粉丝后援会2群」这种意外
  const exact = all.find((r) => `${r.topic()}`.trim() === ROOM_Q.trim());
  if (exact) return exact;
  const hit = all.filter((r) => {
    const t = `${r.topic()}`;
    return t.includes(ROOM_Q);
  });
  if (hit.length > 1) log(`⚠️ 群名「${ROOM_Q}」匹配到 ${hit.length} 个：` + hit.map((r) => r.topic()).join(' / ') + '（用更完整的名字）');
  return hit[0] || null;
}

bot.on('scan', (qrcode, status) => {
  log(`需要扫码登录（status=${status}）：`);
  qrcodeTerminal.generate(qrcode, { small: true });
  log('二维码内容：https://wechaty.js.org/qrcode/' + encodeURIComponent(qrcode));
});

bot.on('login', async (user) => {
  online = true;
  log(`登录成功：${user.name()}`);
  try {
    room = await findRoom();
    log(room ? `已锁定群：${room.topic()}` : (ROOM_Q ? `⚠️ 没找到群「${ROOM_Q}」，先跑 node bot.mjs --rooms 看群名` : '未配置 WX_ROOM，/push 会失败'));
  } catch (e) { log('找群失败：' + String(e.message).slice(0, 80)); }
});

bot.on('logout', (user) => { online = false; room = null; log(`已登出：${user.name()}`); });
bot.on('error', (e) => { lastErr = String(e?.message || e).slice(0, 120); log('错误：' + lastErr); });

await bot.start().catch((e) => { log('启动失败：' + String(e?.message || e)); process.exit(1); });

if (LIST_ONLY) {
  for (let i = 0; i < 60 && !online; i++) await new Promise((r) => setTimeout(r, 1000));
  const all = await bot.Room.findAll();
  log(`这个号在 ${all.length} 个群里：`);
  for (const r of all) log('  · ' + (await r.topic()));
  await bot.stop();
  process.exit(0);
}

/* ---------------- 本地 HTTP ---------------- */
const server = createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json;charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url.startsWith('/health')) {
    return send(200, { online, room: room ? `${room.topic()}` : '', lastAt, lastErr });
  }
  if (req.method === 'GET' && req.url.startsWith('/rooms')) {
    bot.Room.findAll().then((all) => Promise.all(all.map((r) => r.topic())))
      .then((names) => send(200, { count: names.length, rooms: names }))
      .catch((e) => send(500, { error: String(e.message) }));
    return;
  }
  if (req.method !== 'POST' || !req.url.startsWith('/push')) return send(404, { error: 'not found' });

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
  req.on('end', async () => {
    if (!online) return send(503, { error: '微信未登录' });
    let text = '';
    try { text = String(JSON.parse(body || '{}').text || ''); } catch { /* 纯文本也收 */ }
    if (!text) text = body.trim();
    if (!text) return send(400, { error: 'empty' });
    if (!room) {
      room = await findRoom().catch(() => null);
      if (!room) return send(503, { error: '群未就绪（WX_ROOM 没配或没找到）' });
    }
    try {
      await room.say(text);
      lastAt = Date.now();
      log(`已发送 → ${room.topic()}：` + text.split('\n')[0].slice(0, 40));
      send(200, { ok: 1 });
    } catch (e) {
      lastErr = String(e.message).slice(0, 120);
      log('发送失败：' + lastErr);
      send(500, { error: lastErr });
    }
  });
});
server.listen(PORT, '127.0.0.1', () => log(`本地推送口已开：http://127.0.0.1:${PORT}/push`));
