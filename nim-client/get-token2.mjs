/* 取「第二个口袋48账号」的 token + 云信凭据（不覆盖补档站老 token）
 *
 * 🔴 为什么不改 scraper/get-token.mjs：它 writeTokenToEnv() 会覆盖
 *    scraper/.env 里的 POCKET48_TOKEN —— 那是王语晨补档站正在用的主 token，
 *    覆盖 = 补档站抓取全挂。所以这里单独写到 nim-client/nim-account2.env。
 *
 * 两步用法（避免交互式 stdin，方便在工具里跑）：
 *   1) node get-token2.mjs sms    <手机号> [区号]
 *   2) node get-token2.mjs login  <手机号> <短信验证码>
 *
 * ⚠️ 「发送验证码」每失败一次消耗一次答题机会，连续 3 次锁 24 小时。
 *    所以 sms 只发一次，login 也只试一次，别循环重试。
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendSms, loginMobileCode } from '/Users/tansy/WorkBuddy/2026-09-17-16-15-19/wangyuchen-archive/scraper/lib/api.mjs';
import { generatePa } from './pa.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_ENV = resolve(__dirname, 'nim-account2.env');

const appInfo = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
  osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});

async function nimCred(token) {
  const r = await fetch('https://pocketapi.48.cn/im/api/v1/im/userinfo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=utf-8', appInfo,
      'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
      token, pa: generatePa(), 'P-Sign-Type': 'V0',
    },
    body: '{}',
  });
  const j = await r.json();
  return j?.content || null;
}

const [mode, mobile, extra, extra3] = process.argv.slice(2);

/* sms  : 首次发码（境外号会返回人机验证题）
   sms2 : 带答案重发（answer 用接口返回的 value 文本，不是选项编号）
   login: 验证码换 token + 云信凭据 */
if (mode === 'sms' || mode === 'sms2') {
  if (!mobile) { console.error('用法：node get-token2.mjs sms <手机号> [区号]'); process.exit(1); }
  const area = mode === 'sms2' ? extra3 : (extra || '86');
  const answer = mode === 'sms2' ? extra : undefined;
  if (mode === 'sms2' && !answer) { console.error('用法：node get-token2.mjs sms2 <手机号> <答案> [区号]'); process.exit(1); }
  try {
    await sendSms(mobile, area, answer);
    console.log(`✓ 验证码已发送到 +${area} ${mobile.slice(0, 3)}****${mobile.slice(-2)}`);
  } catch (e) {
    if (e.verification) {
      console.log('=== 需要人机验证（境外号）===');
      console.log('题目：' + e.verification.question);
      for (const a of e.verification.answer) console.log(`  [${a.option}] ${a.value}`);
      console.log('\n（把正确选项告诉助手，用 sms2 模式带答案重发一次）');
    } else {
      console.error('✗ 发送失败：', e.message);
    }
    process.exit(1);
  }
} else if (mode === 'login') {
  const code = extra;
  if (!mobile || !code) { console.error('用法：node get-token2.mjs login <手机号> <验证码>'); process.exit(1); }
  const info = await loginMobileCode(mobile, code);
  console.log('✓ 登录成功，userId=' + (info.userId || '?') + ' 昵称=' + (info.nickname || '?'));
  const cred = await nimCred(info.token);
  if (!cred) {
    console.error('✗ 云信凭据换取失败（token 可能无效）');
    process.exit(1);
  }
  let env = existsSync(OUT_ENV) ? readFileSync(OUT_ENV, 'utf8') : '';
  const put = (k, v) => {
    const re = new RegExp('^\\s*' + k + '=.*$', 'm');
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : (env + `\n${k}=${v}\n`);
  };
  put('NIM2_TOKEN', info.token);
  put('NIM2_ACCID', cred.accid);
  put('NIM2_PW', cred.pwd);
  put('NIM2_USERID', info.userId || '');
  writeFileSync(OUT_ENV, env.trim() + '\n');
  console.log('✓ 已写入 ' + OUT_ENV + '（补档站老 token 未改动）');
  console.log('  accid=' + cred.accid);
  console.log('  下一步：用这个号关注全团  node follow-all.mjs --account 2');
} else {
  console.log('用法：');
  console.log('  node get-token2.mjs sms   <手机号> [区号]');
  console.log('  node get-token2.mjs login <手机号> <验证码>');
}
