/* 临时探测：王语晨口袋房间的消息结构 */
import { readFileSync, existsSync } from 'node:fs';
import { fetchMessagePage } from './lib/api.mjs';

const ROOT = '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-live-sync/';
const env = existsSync(ROOT + 'nim-sync.env') ? readFileSync(ROOT + 'nim-sync.env', 'utf8') : '';
const pick = (t, k) => { const m = new RegExp('^' + k + '=(.*)$', 'm').exec(t); return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''; };
const TOKEN = process.env.POCKET48_TOKEN || pick(env, 'POCKET48_TOKEN');
if (!TOKEN) { console.error('没有 POCKET48_TOKEN'); process.exit(1); }

const txt = readFileSync('/Users/tansy/WorkBuddy/2026-10-14-14-13-54/all48-worker/public/data/members.js', 'utf8');
const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
const me = arr.find((m) => String(m.id) === '89653517');
console.log('成员:', me && { id: me.id, name: me.name, srv: me.srv, ch: me.ch });

const r = await fetchMessagePage({ serverId: me.srv, channelId: me.ch, nextTime: 0, limit: 20, token: TOKEN });
console.log('本轮条数:', r.messages.length, ' nextTime:', r.nextTime);

for (const m of r.messages.slice(0, 8)) {
  const ext = (() => { try { return typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : m.extInfo; } catch { return {}; } })();
  const body = (() => { try { return typeof m.bodys === 'string' ? JSON.parse(m.bodys) : m.bodys; } catch { return {}; } })();
  console.log('---');
  console.log(' msgType:', m.msgType, '| msgTime:', m.msgTime, new Date(Number(m.msgTime) + 8 * 3600e3).toISOString().slice(0, 19));
  console.log(' 用户:', (ext.user || {}).nickname, 'uid', (ext.user || {}).userId);
  console.log(' bodys keys:', Object.keys(body || {}).join(','));
  console.log(' 完整:', JSON.stringify(m).slice(0, 900));
}
