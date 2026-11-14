import test from 'node:test';
import assert from 'node:assert/strict';
import { bjMs, parseOnlineRecord, mergeOnlineRecords, summaryOf } from '../online-record.mjs';

/* 站长 2026-11-13 晚上在微信群里查到的真实回复（原样保留） */
const SAMPLE = `黄宣绮 的口袋在线记录:【1】页
当前时间11-13 20:54:33
now:🕑离线 [31:16前]
11-13 20:22在线 [0:22]
11-13 20:15在线 [2:03]
11-13 18:56在线 [4:42]
11-13 18:54在线 [0:50]
11-13 18:48在线 [2:19]
11-13 15:50在线 [0:23]
11-13 14:50在线 [0:27]
11-13 14:32在线 [4:42]
11-13 14:03在线 [2:18]
11-13 11:18在线 [1:36]
11-12 23:28在线 [3:17]
11-12 23:10在线 [13:44]
11-12 22:36在线 [3:56]
11-12 22:22在线 [4:40]
11-12 22:08在线 [4:43]
11-12 21:54在线 [6:10]
11-12 21:44在线 [1:17]
11-12 21:11在线 [3:02]
11-12 17:03在线 [4:42]
11-12 13:00在线 [2:07]`;

const NOW = bjMs(2026, 11, 13, 20, 54, 33);
const rec = parseOnlineRecord(SAMPLE, { now: NOW });

test('① 标题 / 页码 / 查询时刻', () => {
  assert.equal(rec.name, '黄宣绮');
  assert.equal(rec.page, 1);
  assert.equal(rec.asOfText, '11-13 20:54:33');
  assert.equal(rec.asOf, bjMs(2026, 11, 13, 20, 54, 33));
});

test('② now 状态与「多久前」', () => {
  assert.equal(rec.now.online, false);
  assert.equal(rec.now.state, '离线');
  assert.equal(rec.now.sinceSec, 31 * 60 + 16);
  assert.equal(rec.now.sinceMs, rec.asOf - rec.now.sinceSec * 1000);
});

test('③ 20 段全部解析 + 北京时间换算', () => {
  assert.equal(rec.rows.length, 20);
  assert.equal(rec.rows[0].date, '11-13');
  assert.equal(rec.rows[0].time, '20:22');
  assert.equal(rec.rows[0].ts, bjMs(2026, 11, 13, 20, 22, 0));
  assert.equal(rec.rows[0].durSec, 22);
  assert.equal(rec.rows.at(-1).ts, bjMs(2026, 11, 12, 13, 0, 0));
  assert.equal(rec.rows.at(-1).durSec, 2 * 60 + 7);
  // 按时间倒序
  assert.ok(rec.rows.every((r, i) => i === 0 || rec.rows[i - 1].ts >= r.ts));
});

test('④ 统计：67:20 / 中位 2:40 / 5 段保活超时', () => {
  assert.equal(rec.stats.segments, 20);
  assert.equal(rec.stats.totalSec, 67 * 60 + 20);
  assert.equal(rec.stats.minSec, 22);
  assert.equal(rec.stats.maxSec, 13 * 60 + 44);
  assert.equal(rec.stats.medianSec, 161); // 20 段，中间两个 139s / 182s → 160.5 取整
  assert.equal(rec.stats.keepaliveLike, 5);
});

test('⑤ 合并去重：同一份快照重复转发不涨行数', () => {
  const a = mergeOnlineRecords(null, rec);
  assert.equal(a.rows.length, 20);
  assert.equal(a.snapshots, 1);
  const b = mergeOnlineRecords(a, parseOnlineRecord(SAMPLE, { now: NOW + 60000 }));
  assert.equal(b.rows.length, 20, '重复快照不该产生新行');
  assert.equal(b.snapshots, 2);
});

test('⑥ 新快照里的新一段会被并进时间线', () => {
  const fresh = SAMPLE.replace('11-13 20:22在线 [0:22]', '11-13 20:40在线 [1:05]\n11-13 20:22在线 [0:22]');
  const c = mergeOnlineRecords(mergeOnlineRecords(null, rec), parseOnlineRecord(fresh, { now: NOW + 60000 }));
  assert.equal(c.rows.length, 21);
  assert.equal(c.rows[0].time, '20:40');
  assert.equal(c.rows[0].durSec, 65);
});

test('⑦ 跨年：查询在 1 月、记录里出现 12 月 ⇒ 归上一年', () => {
  const t = `王语晨 的口袋在线记录:【1】页
当前时间01-02 10:00:00
now:在线 [0:10前]
01-02 09:50在线 [0:10]
12-31 23:00在线 [1:00]`;
  const r = parseOnlineRecord(t, { now: bjMs(2027, 1, 2, 10, 0, 0) });
  assert.equal(r.rows[0].ts, bjMs(2027, 1, 2, 9, 50, 0));
  assert.equal(r.rows[1].ts, bjMs(2026, 12, 31, 23, 0, 0));
});

test('⑧ 普通群聊消息 / 空文本一律返回 null（不误伤）', () => {
  assert.equal(parseOnlineRecord(''), null);
  assert.equal(parseOnlineRecord('今天公演好看吗'), null);
  assert.equal(parseOnlineRecord('黄宣绮 的口袋在线记录:【1】页'), null);
  assert.equal(parseOnlineRecord('lg 黄宣绮'), null);
});

test('⑨ 摘要可直接发群', () => {
  const s = summaryOf(rec);
  assert.match(s, /黄宣绮/);
  assert.match(s, /离线/);
  assert.match(s, /1小时7分20秒/);
  assert.match(s, /20 段/);
});

test('⑩ 缺「当前时间」也能解析（用收到消息的时间补年份）', () => {
  const r = parseOnlineRecord(SAMPLE.replace('当前时间11-13 20:54:33\n', ''), { now: NOW });
  assert.equal(r.rows.length, 20);
  assert.equal(r.rows[0].ts, bjMs(2026, 11, 13, 20, 22, 0));
  assert.equal(r.asOfText, '');
});

/* 站长 22:44 转发到「bot小群2」的截图原文（空格变体 + 新增一段 21:04）。
   微信里显示成 `: 【1】 页` / `当前时间 11-13` / `now:🕐离线` / `21:04 在线`，
   比第一次粘贴的版本多了空格，必须都吃得下。截图下半截被裁，只取可见的 10 行。 */
const SHOT = `黄宣绮 的口袋在线记录: 【1】 页
当前时间 11-13 21:44:00
now:🕐离线 [19:49前]
11-13 21:04 在线 [19:43]
11-13 20:22 在线 [0:22]
11-13 20:15 在线 [2:03]
11-13 18:56 在线 [4:42]
11-13 18:54 在线 [0:50]
11-13 18:48 在线 [2:19]
11-13 15:50 在线 [0:23]
11-13 14:50 在线 [0:27]
11-13 14:32 在线 [4:42]
11-13 14:03 在线 [2:18]`;
const shotRec = parseOnlineRecord(SHOT, { now: bjMs(2026, 11, 13, 21, 44, 0) });

test('⑪ 微信截图空格变体全部兼容', () => {
  assert.equal(shotRec.name, '黄宣绮');
  assert.equal(shotRec.page, 1);
  assert.equal(shotRec.asOfText, '11-13 21:44:00');
  assert.equal(shotRec.now.sinceSec, 19 * 60 + 49);
  assert.equal(shotRec.rows.length, 10);
  assert.equal(shotRec.rows[0].time, '21:04');
  assert.equal(shotRec.rows[0].durSec, 19 * 60 + 43);
  assert.equal(shotRec.rows[1].time, '20:22');
});

test('⑫ 两次真实快照合并：只多出 21:04 那一段', () => {
  const a = mergeOnlineRecords(null, rec);            // 20:54 那份，20 段
  const b = mergeOnlineRecords(a, shotRec);           // 21:44 这份，11 段
  assert.equal(b.rows.length, 21);                   // 20 段 + 新增 21:04
  assert.equal(b.rows[0].time, '21:04');
  assert.equal(b.snapshots, 2);
  assert.equal(b.lastNow.sinceSec, 19 * 60 + 49);    // 以最新快照为准
});

/* 第三张截图：now 变成「💡 已在线 [5:22]」（没有「前」），是已在线时长，不是距下线 */
const ONLINE_NOW = `黄宣绮 的口袋在线记录: 【1】 页
当前时间11-13 21:50:02
now: 💡 已在线 [5:22]
11-13 21:04在线 [19:43]
11-13 20:22在线 [0:22]
11-13 20:15在线 [2:03]
11-13 18:56在线 [4:42]
11-13 18:54在线 [0:50]
11-13 18:48在线 [2:19]`;
const onRec = parseOnlineRecord(ONLINE_NOW, { now: bjMs(2026, 11, 13, 21, 50, 2) });

test('⑬ 已在线 [5:22]：识别状态词、区分语义、不硬加「前」', () => {
  assert.equal(onRec.now.online, true);
  assert.equal(onRec.now.state, '已在线');
  assert.equal(onRec.now.metric, 'online_elapsed');
  assert.equal(onRec.now.sinceSec, 5 * 60 + 22);
  assert.equal(onRec.now.sinceText, '5:22');
  assert.equal(onRec.now.hasSuffix, false);
  assert.equal(onRec.rows.length, 6);
  assert.equal(onRec.rows[0].time, '21:04');
  assert.match(summaryOf(onRec), /已在线 5分22秒/);
  // 旧格式仍然保持「距下线」语义
  assert.equal(rec.now.metric, 'offline_elapsed');
  assert.equal(rec.now.sinceText, '31:16前');
  assert.equal(rec.now.hasSuffix, true);
});
