import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = () => ({ 'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' });
const post = async (p, b) => {
  const r = await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H(), body: JSON.stringify(b || {}) });
  let t = await r.text();
  return [r.status, t];
};

// 候选完整路径（注解值 × 可能前缀）
const cands = [
  // 查鸡腿数
  ['/user/money', {}],
  ['/gift/user/money', {}],
  ['/user/api/v1/money', {}],
  ['/gift/api/v1/user/money', {}],
  // 队伍月榜 / MVP
  ['/gift/teamMonthRank', { rankId: 429 }],
  ['/gift/teamPic', {}],
  ['/gift/mvpRank', { nextId: 0 }],
  ['/gift/mvpPastRank', {}],
  ['/gift/pastMonthRecord', {}],
  ['/gift/voteRecord', { nextId: 0 }],
  // 直播榜
  ['/live/getLiveRank', { liveId: 0 }],
  ['/live/getOpenLiveMemberRank', { nextId: 0 }],
  // 应援
  ['/gift/api/v1/goods/list', { nextId: 0 }],
  ['/gift/api/v1/exchange/status', {}],
];

for (const [p, b] of cands) {
  const [s, t] = await post(p, b);
  const short = t.replace(/\s+/g, ' ').slice(0, 170);
  console.log(String(s).padEnd(4), p.padEnd(34), short);
  await new Promise(r => setTimeout(r, 130));
}
