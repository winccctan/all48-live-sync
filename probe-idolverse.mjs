// 探测「鸡腿周报」接口是否真实存在：带真实 pa 签名 + 真实 token
import { postJson } from './lib/api.mjs';

const token = process.env.POCKET48_TOKEN;
const bodies = {
  weekly: { memberId: 63547, page: 1, pageSize: 20, type: 1 },
  live: { liveId: '0' },
  empty: {}
};

const cases = [
  ['A 用户给的周榜路径', '/idolverse/api/v1/live/ranking/weekly', 'weekly'],
  ['B 用户给的成员榜路径', '/idolverse/api/v1/gift/ranking/member', 'weekly'],
  ['C 前缀对照组(乱写)', '/idolverse/api/v1/zzz/doesnotexist', 'empty'],
  ['D 疑似真前缀 gift', '/gift/api/v1/gift/ranking/member', 'weekly'],
  ['E 疑似真前缀 live', '/live/api/v1/live/getLiveRanking', 'weekly'],
  ['F 已知可用(签名对照)', '/live/api/v1/live/getLiveOne', 'live'],
];

for (const [name, path, bkey] of cases) {
  try {
    const r = await postJson(path, bodies[bkey], { token, retries: 0 });
    console.log(`OK  ${name}\n    ${path}\n    ${JSON.stringify(r).slice(0, 300)}\n`);
  } catch (e) {
    const m = String(e.message || e);
    const isHtml = /<html|nginx|<head/i.test(m);
    console.log(`ERR ${name}\n    ${path}\n    ${isHtml ? '[HTML 错误页] ' : ''}${m.slice(0, 260)}\n`);
  }
}
