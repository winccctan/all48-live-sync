// 王语晨补档站 - 抓取配置
// 数据来源：https://github.com/duan602728596/48tools （口袋48 接口逆向）
//
// 成员信息来自 48tools 维护的成员目录 roomId.json（已核对）：
//   王语晨 | GNZ48 TEAM NIII | GNZ48 十三期生
//   starId/memberId: 89653517
//   serverId: 2278592  channelId: 2541547  liveRoomId: 2466022879
//   groupId: 12 (GNZ48)

import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

if (!globalThis.crypto) {
  globalThis.crypto = webcrypto;
}

// 零依赖读取 .env（若存在），让脚本在手动或自动运行时都能拿到 POCKET48_TOKEN
function loadEnv() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const envPath = resolve(here, '..', '.env');
    const text = readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // 没有 .env 则回退到系统环境变量
  }
}
loadEnv();

// 王语晨的固定身份参数（无需改动）
export const MEMBER = {
  name: '王语晨',
  starId: 89653517, // 成员 id（用于按成员筛选直播）
  userId: 89653517, // 与 starId 相同，口袋48 体系中即成员 userId
  // 口袋房间（server）只有 1 个：serverId=2278592，房间名「一只鱼🐟」（系统默认名「王语晨」）。
  // ★ 房间底部有多个频道（App 顶部 tab）：萌学园ᜊ = channelId 2541547，另有名为「1」的频道（空频道）。
  //   ⚠️ 所有抓取脚本都只传 MEMBER.channelId ⇒ 天然只抓「萌学园ᜊ」，
  //      「1」等其它频道的发言不会进站（2026-09-24 站长确认，无需额外排除逻辑）。
  serverId: 2278592, // 口袋房间 serverId（口袋发言用）
  channelId: 2541547, // 口袋房间 channelId（口袋发言用）＝「萌学园ᜊ」
  liveRoomId: 2466022879, // 口袋直播房间 id
  groupId: 12, // GNZ48
  team: 'TEAM NIII', // 王语晨所在队伍（公演按此过滤：只抓她参加的公演）
  teamId: 1202, // TEAM NIII 的 teamId
  period: 'GNZ48 十三期生'
};

// 口袋48 接口根地址
export const API_BASE = 'https://pocketapi.48.cn';

// 从环境变量读取登录 token（口袋发言必须）
// 获取方式见项目 README
export const POCKET48_TOKEN = process.env.POCKET48_TOKEN || '';

// 抓取上限（防止异常时无限翻页）
export const MAX_PAGES = Number(process.env.MAX_PAGES || 200);
