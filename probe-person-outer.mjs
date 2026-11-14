/* 验证：getPersonMeleeRankPage 用 resId（成员 ID）调用时，
 * 响应**外层字段**里是否带该成员的总鸡腿/总分（不只是 TOP16 粉丝）。
 * 上一轮一直用 rankId/nextId ⇒ 恒 500，可能根本是参数名错。 */
import fs from 'fs';
const ufetch = fetch;

const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = fs.readFileSync(ROOT + 'nim-sync.env', 'utf8');
const pick = (k) => { const m = env.match(new RegExp('^' + k + '=(.*)$', 'm')); return m ? m[1].trim() : ''; };
const TOKEN = pick('POCKET48_TOKEN');
const { generatePa } = await import(ROOT + 'nim-client/pa.mjs');

const mkApp = (v, b) => JSON.stringify({ vendor: 'apple', deviceId: '7B93DFD0-472F-4736-A628-E85FAE086486', appVersion: v, appBuild: b, osVersion: '16.3.1', osType: 'ios', deviceName: 'iPhone XR', os: 'ios' });
const H = (v, b) => ({
  'Content-Type': 'application/json;charset=utf-8',
  appInfo: mkApp(v, b), token: TOKEN, pa: generatePa(),
  'Accept-Language': 'zh-Hans-CN;q=1',
  'User-Agent': `PocketFans201807/${v} (iPhone; iOS 16.3.1; Scale/2.00)`,
});
const post = async (p, body, v = '7.0.41', b = '24011601') => {
  const r = await ufetch('https://pocketapi.48.cn' + p, {
    method: 'POST', headers: H(v, b), body: JSON.stringify(body || {}),
  });
  return [r.status, await r.text()];
};

const WYC = 89653517, BXY = 614528, ZYX = 530452;
const EP = '/gift/api/v1/melee/rank/getPersonMeleeRankPage';

const bodies = [
  ['resId', { resId: WYC }],
  ['resId+rankId', { resId: WYC, rankId: 429 }],
  ['resId+nextId', { resId: WYC, nextId: 0 }],
  ['resId string', { resId: String(WYC) }],
  ['memberId', { memberId: WYC }],
  ['starId', { starId: WYC }],
  ['uid', { uid: WYC }],
  ['userId', { userId: WYC }],
  ['id', { id: WYC }],
  ['resId+page', { resId: WYC, pageIndex: 1, pageSize: 50 }],
];

for (const [tag, body] of bodies) {
  const [s, t] = await post(EP, body);
  let brief = t.replace(/\s+/g, ' ');
  console.log(`\n=== ${tag.padEnd(14)} http=${s} len=${t.length}`);
  console.log('   ', brief.slice(0, 400));
  await new Promise((x) => setTimeout(x, 400));
}

/* 拿到一次 200 的完整 JSON：打印所有**外层**键（content 除外）+ content 的键 */
console.log('\n\n=== 完整结构（resId 版） ===');
const [s2, t2] = await post(EP, { resId: WYC });
console.log('http', s2, 'len', t2.length);
try {
  const o = JSON.parse(t2);
  const walk = (ob, path = '', d = 0) => {
    if (d > 2 || !ob || typeof ob !== 'object') return;
    for (const [k, v] of Object.entries(ob)) {
      const ty = Array.isArray(v) ? `array(${v.length})` : typeof v;
      const sample = (typeof v === 'object' && v) ? '' : ` = ${String(v).slice(0, 60)}`;
      console.log('  '.repeat(d) + path + k + `: ${ty}${sample}`);
      if (Array.isArray(v) && v.length) walk(v[0], path + k + '[0].', d + 1);
      else if (typeof v === 'object') walk(v, path + k + '.', d + 1);
    }
  };
  walk(o);
} catch (e) {
  console.log('非 JSON，前 600 字：', t2.slice(0, 600));
}
