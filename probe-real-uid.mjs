import fs from 'fs';
const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = k => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');
const appInfo = JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: '7.0.41', appBuild: '24011601', osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = () => ({ 'Content-Type': 'application/json;charset=utf-8', appInfo, token: TOKEN, pa: generatePa(), 'Accept-Language': 'zh-Hans-CN;q=1', 'User-Agent': 'PocketFans201807/7.0.41 (iPhone; iOS 16.3.1; Scale/2.00)' });
const post = async (p, b) => (await (await fetch('https://pocketapi.48.cn' + p, { method: 'POST', headers: H(), body: JSON.stringify(b || {}) })).json());

const P = '/gift/api/v1/melee/rank/';
// 1) 拿真实成员 uid
const top = await post(P + 'getMeleeRankPage', {});
const list = top.content?.meleeRank?.rankUserList || [];
console.log('=== 总榜 top7（真实 uid）');
list.forEach(x => console.log(' ', x.rankNum, x.baseUserInfo.starName, 'uid=' + x.baseUserInfo.userId, 'melee=' + x.melee));

const uids = list.map(x => x.baseUserInfo.userId);
const names = list.map(x => x.baseUserInfo.starName);

// 2) 用真实 uid 打个人榜
const EPs = ['getPersonMeleeRankPage', 'getClubMeleeRankPage'];
const KEYS = ['userId', 'starId', 'memberId', 'id', 'targetUserId'];
for (const ep of EPs) {
  for (const k of KEYS) {
    const body = { rankId: 429, [k]: uids[0] };
    const r = await post(P + ep, body);
    const ok = r.status !== 500;
    console.log(`${ok ? 'OK ' : '   '} ${ep.padEnd(22)} ${JSON.stringify(body).padEnd(40)} st=${r.status} ${r.message || ''} ${JSON.stringify(r.content || {}).slice(0, 120)}`);
    await new Promise(x => setTimeout(x, 110));
  }
}
