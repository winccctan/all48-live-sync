/**
 * 诊断：msg48 取址通道在 GitHub Actions 出口上到底能不能用。
 *
 * 背景：本机（沙箱）直连 msg48 完全正常；但回填任务里同一条通道只成功 2 次，
 * 怀疑是 Actions（Azure 美国出口）被挡或触发限流。本脚本把每一次请求的结果和
 * 错误原文都打出来，用来判断「能不能拿它当主通道」。
 *
 * 用法：workflow「录播回填」inputs.probe=2 + uids=1
 */
import { fetchLiveListPage, fetchNewestLiveId, pickPlayable } from './lib/api.mjs';

const UIDS = (process.env.UIDS || '1').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const N = Number(process.env.PROBE_N || 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const newest = await fetchNewestLiveId({ groupId: 1, record: true });
log('翻页起点 liveId=' + newest);

const uid = UIDS[0];
const r = await fetchLiveListPage({ userId: uid, next: newest, record: true });
const list = (r.list || []).slice(0, N);
log(`取 ${list.length} 场做 msg48 取址测试`);

let ok = 0;
const errs = new Map();
for (let i = 0; i < list.length; i++) {
  const it = list[i];
  let play = '';
  let note = '';
  try {
    const res = await fetch('https://msg48.org/api/live/getLiveOne', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ liveId: String(it.liveId) }),
    });
    const txt = await res.text();
    if (!res.ok) {
      note = `HTTP ${res.status} ${txt.slice(0, 120)}`;
    } else {
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { note = '非 JSON：' + txt.slice(0, 120); }
      if (j) {
        if (!j.success) note = 'success=false ' + String(j.message || '').slice(0, 80);
        else {
          play = pickPlayable([j.content && j.content.playStreamPath]);
          note = play ? 'OK' : '成功但 playStreamPath 为空';
        }
      }
    }
  } catch (e) {
    note = 'EXCEPTION ' + String((e && e.message) || e).slice(0, 120);
  }
  if (play) ok++;
  else errs.set(note, (errs.get(note) || 0) + 1);
  log(`  #${i} ${new Date(Number(it.ctime) || 0).toISOString().slice(0, 10)} ${play ? '✅ ' + play.slice(0, 60) : '❌ ' + note}`);
}
log(`==== msg48 取址 ${ok}/${list.length} 成功 ====`);
if (errs.size) log('失败分布：' + [...errs.entries()].map(([m, n]) => `${n}× ${m}`).join(' | '));
