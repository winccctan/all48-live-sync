// 找「活动榜单」：首页 Banner 活动 → 活动榜接口
import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({
  vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486',
  appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1',
  osType: 'ios', deviceName: 'iPhone XR', os: 'ios',
});
const H = {
  'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1',
  'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)',
};
const post = async (p, b) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H, body: JSON.stringify(b || {}) });
  return [r.status, await r.text()];
};
const paths = [
  '/user/api/v1/active/list/ongoing',
  '/gift/api/v1/active/list/ongoing',
  '/home/api/rank/main',
  '/home/api/rank/list',
  '/user/api/v1/rank/main',
  '/user/api/v1/rank/list',
  '/user/api/v1/active/list',
  '/post/api/v1/active/list/ongoing',
  '/posts/api/v1/active/list/ongoing',
];
for (const p of paths) {
  const [c, t] = await post(p, {});
  const ok = !/"status\":404/.test(t) && c !== 404;
  console.log((ok ? 'HIT  ' : 'MISS ') + c + ' ' + p + ' -> ' + t.replace(/\s+/g, ' ').slice(0, 240));
  await new Promise((r) => setTimeout(r, 130));
}
