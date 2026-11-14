/**
 * 云信「在线状态订阅」命令行入口（需云端凭据，缺配置时只自检、不联网）
 *
 *   node presence.mjs --check                     # 本地自检，不联网、不报错
 *   node presence.mjs --subscribe <accid...>     # 订阅（30 天），自动按 100 分批
 *   node presence.mjs --renew <accid...>         # 续订
 *   node presence.mjs --query <accid...>         # 查订阅关系
 *   node presence.mjs --unsubscribe <accid...>   # 取消
 *   node presence.mjs --clear                    # 清空订阅人全部订阅
 *   node presence.mjs --ingest '{"accid":"...","value":1,"time":...,"name":"..."}'
 *   node presence.mjs --log <accid> --name 名字  # 打印「口袋在线记录」
 *   node presence.mjs --stats                    # 日志统计
 *
 * 🔴 凭据从 presence.env / 环境变量读，代码里不硬编码任何 AppKey/AppSecret/accid。
 *    没配置时 --check 之外所有联网命令会明确报错退出，不会伪造或去别处找密钥。
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as api from './lib/yunxin-presence.mjs';
import * as log from './lib/presence-log.mjs';

// 只在本地读入 .env 形态的配置，绝不写回、绝不打印值
const envPath = resolve(import.meta.dirname, 'presence.env');
if (existsSync(envPath) && !process.env.YUNXIN_APP_KEY) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !m[1].startsWith('#') && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argsAfter = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return [];
  const out = [];
  for (let k = i + 1; k < argv.length; k++) {
    if (argv[k].startsWith('--')) break;
    out.push(argv[k]);
  }
  return out;
};
const valueOf = (name) => argsAfter(name)[0] || '';

function die(e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}

async function main() {
  if (flag('--check') || !argv.length) {
    const s = api.checkConfig();
    console.log('云信在线状态订阅 · 本地自检（不联网）');
    console.log('  YUNXIN_APP_KEY    ', s.hasAppKey ? '已配置' : '❌ 缺');
    console.log('  YUNXIN_APP_SECRET ', s.hasAppSecret ? '已配置' : '❌ 缺');
    console.log('  YUNXIN_SUB_ACCID  ', s.hasSubAccid ? '已配置' : '❌ 缺');
    console.log('\n  四个前置条件（官方口径，缺一不可）：');
    const mark = { ok: '✓', missing: '❌', unknown: '?' };
    for (const [i, x] of api.prerequisites().items.entries()) {
      console.log(`   ${i + 1}. ${mark[x.state]} ${x.key} — ${x.note}`);
    }
    console.log('\n  另两条独立路径（同样需应用所有者权限，本工具未实现）：');
    console.log('     · 登录登出消息抄送 LOGIN/LOGOUT → 开发者服务器 Webhook（需控制台配 URL + 真实报文样本）');
    console.log('     · history/queryUserEvents.action → 主动查，查不到开通前的历史');
    if (s.ok) console.log('\n→ 凭据齐备；注意上面 ? 项仍待确认，可谨慎试用 --query');
    else console.log('\n→ 凭据不齐，联网命令会拒绝执行（本工具不会获取/伪造密钥）');
    const st = log.stats();
    console.log(`  本地事件日志：成员 ${st.members} / 会话 ${st.sessions} / 当前在线 ${st.onlineNow}`);
    return;
  }

  if (flag('--stats')) { console.log(log.stats()); return; }

  if (flag('--ingest')) {
    const raw = valueOf('--ingest');
    if (!raw) die(new Error('--ingest 需要一个 JSON 字符串'));
    let evt;
    try { evt = JSON.parse(raw); } catch { die(new Error('--ingest 的 JSON 解析失败')); }
    const r = log.ingest(evt);
    console.log(r.changed ? `✓ 已记录：${r.reason}` : `· 忽略：${r.reason}`);
    return;
  }

  if (flag('--log')) {
    const accid = valueOf('--log');
    if (!accid) die(new Error('--log 需要 accid'));
    const lines = log.render(accid, {
      name: valueOf('--name'),
      page: Number(valueOf('--page')) || 1,
      limit: Number(valueOf('--limit')) || 21,
    });
    console.log(lines.join('\n'));
    return;
  }

  // 以下都要联网 => 必须有凭据
  if (flag('--clear')) { console.log(await api.clearAll()); return; }
  const ids = argsAfter('--subscribe').length ? argsAfter('--subscribe')
            : argsAfter('--renew').length ? argsAfter('--renew')
            : argsAfter('--query').length ? argsAfter('--query')
            : argsAfter('--unsubscribe');
  if (!ids.length) die(new Error('需要 accid 列表'));

  if (flag('--subscribe') || flag('--renew')) {
    const r = flag('--renew') ? await api.renew(ids) : await api.subscribe(ids);
    console.log(`✓ 订阅完成：${ids.length} 个 / ${r.batches} 批 / 失败 ${r.failedAccid.length} 个`);
    if (r.failedAccid.length) console.log('  失败 accid:', r.failedAccid.join(','));
  } else if (flag('--query')) {
    const rows = await api.query(ids);
    console.log('有效订阅关系', rows.length, '条');
    for (const x of rows) console.log(' ', x.accid, 'expireTime', x.expireTime);
  } else if (flag('--unsubscribe')) {
    const r = await api.unsubscribe(ids);
    console.log(`✓ 取消完成：失败 ${r.failedAccid.length} 个`);
  } else {
    die(new Error('未知命令'));
  }
}

main().catch(die);
