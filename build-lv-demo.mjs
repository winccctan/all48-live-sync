/**
 * 用 giftall-sync.mjs 抓下来的 JSON 生成「口袋48 礼物鸡腿榜」单文件 demo。
 *   node build-lv-demo.mjs <输入json> [输出html]
 *
 * 为什么是单文件：demo 阶段不碰线上 Worker，把数据烘进页面，直接双击/预览就能看。
 * 以后要上线，只需把 window.LV_DATA 换成 fetch('/api/lv') 即可，页面逻辑不用改。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { priceOf } from './lib/gift-price.mjs';

const IN = process.argv[2];
const OUT = process.argv[3] || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/output/lv-demo.html';
if (!IN) { console.error('用法: node build-lv-demo.mjs <输入json> [输出html]'); process.exit(1); }

const SITE = (process.env.SITE_URL || 'https://all48-archive.yqz-tansy.workers.dev').replace(/\/+$/, '');
const raw = JSON.parse(readFileSync(IN, 'utf8'));
/* 🔴 room: 1=大家房间 2=成员直播 3=官方公演直播。公演礼物走独立榜，绝不混进这三个礼物榜。 */
const PERF_ROOM = 3;
const items = (raw.items || []).filter((r) => Number(r.room) !== PERF_ROOM);
const BJ = 8 * 3600 * 1000;

/* ---------- 成员目录：补团/队（页面按团筛选用） ---------- */
const mem = new Map();
try {
  const txt = await (await fetch(SITE + '/data/members.js', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const arr = JSON.parse(txt.slice(txt.indexOf('['), txt.lastIndexOf(']') + 1));
  for (const m of arr) mem.set(Number(m.id), m);
} catch (e) {
  console.warn('成员目录拉取失败（团/队标签会缺）：' + String(e.message).slice(0, 80));
}

/* ---------- 服务端做的事，这里先做一遍（以后搬到 Worker） ---------- */
const memberMap = new Map();
const senderMap = new Map();
const giftMap = new Map();

for (const r of items) {
  // 🔴 单价一律按现行价目表重算，忽略 JSON 里存的历史 val/v ——
  //    这样改价（例如「弹幕不计鸡腿」）只要重建 demo 就生效，不必重跑抓取。
  const price = priceOf(r.gid, r.g);
  const num = Number(r.num) || 0;
  const val = price * num;
  const mm = mem.get(Number(r.mid)) || {};

  let m = memberMap.get(r.mid);
  if (!m) {
    m = {
      id: r.mid, n: r.mn || String(r.mid), g: mm.g || '其他', t: mm.tm || '',
      val: 0, num: 0, cnt: 0, senders: new Map(), gifts: new Map(), last: 0, live: 0, room: 0,
    };
    memberMap.set(r.mid, m);
  }
  m.val += val; m.num += num; m.cnt++;
  if (r.t > m.last) m.last = r.t;
  if (Number(r.room) === 2) m.live++; else m.room++;

  const ms = m.senders.get(r.sid) || { id: r.sid, n: r.sn, val: 0, num: 0, cnt: 0 };
  ms.val += val; ms.num += num; ms.cnt++; m.senders.set(r.sid, ms);

  const mg = m.gifts.get(r.g) || { g: r.g, v: price, num: 0, cnt: 0, val: 0 };
  mg.num += num; mg.cnt++; mg.val += val; m.gifts.set(r.g, mg);

  let s = senderMap.get(r.sid);
  if (!s) { s = { id: r.sid, n: r.sn || String(r.sid), val: 0, num: 0, cnt: 0, to: new Set() }; senderMap.set(r.sid, s); }
  s.val += val; s.num += num; s.cnt++; s.to.add(r.mid);

  let g = giftMap.get(r.g);
  if (!g) { g = { g: r.g, v: price, num: 0, cnt: 0, val: 0, to: new Set() }; giftMap.set(r.g, g); }
  g.num += num; g.cnt++; g.val += val; g.to.add(r.mid);
}

const members = [...memberMap.values()].map((m) => ({
  id: m.id, n: m.n, g: m.g, t: m.t, val: m.val, num: m.num, cnt: m.cnt, last: m.last, live: m.live, room: m.room,
  senders: [...m.senders.values()].sort((a, b) => b.val - a.val || b.cnt - a.cnt),
  gifts: [...m.gifts.values()].sort((a, b) => b.val - a.val),
})).sort((a, b) => b.val - a.val || b.cnt - a.cnt);

const senders = [...senderMap.values()].map((s) => ({
  id: s.id, n: s.n, val: s.val, num: s.num, cnt: s.cnt, to: s.to.size,
})).sort((a, b) => b.val - a.val || b.cnt - a.cnt);

const gifts = [...giftMap.values()].map((g) => ({
  g: g.g, v: g.v, val: g.val, num: g.num, cnt: g.cnt, to: g.to.size,
})).sort((a, b) => b.val - a.val);

/* 团计数（用于筛选 chip 上的数字） */
const GROUPS = ['SNH48', 'GNZ48', 'BEJ48', 'CKG48', 'CGT48', 'IDFT', '其他'];
const groupCount = {};
for (const m of members) groupCount[m.g] = (groupCount[m.g] || 0) + 1;

const totalVal = members.reduce((a, b) => a + b.val, 0);
const totalNum = members.reduce((a, b) => a + b.num, 0);

/* ---------- 公演直播：场次 + 队伍鸡腿 ---------- */
const PERF_FILE = process.env.PERF || '/Users/tansy/WorkBuddy/2026-10-14-14-13-54/output/perf-20261024.json';
const PERF_GIFTS = process.env.PERF_GIFTS || '';   // 公演直播间采集到的礼物 jsonl（没有就空）
let perfRaw = { perf: [] };
try { perfRaw = JSON.parse(readFileSync(PERF_FILE, 'utf8')); } catch { console.warn('公演排期文件缺失，公演页留空'); }

const NOW = Date.now();
/* 🔴 公演榜只算 2026-10-24 00:00（北京）之后的场次，之前的官方归档一律不进。 */
const PERF_SINCE = Date.parse('2026-10-23T16:00:00Z');
const perfAll = (perfRaw.perf || []).filter((p) => Number(p.st) >= PERF_SINCE);
const perfPast = perfAll.filter((p) => p.st <= NOW);
const perfFuture = perfAll.filter((p) => p.st > NOW).sort((a, b) => a.st - b.st).slice(0, 12);

let perfGiftRecords = [];
if (PERF_GIFTS) {
  try {
    perfGiftRecords = readFileSync(PERF_GIFTS, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { console.warn('公演礼物文件读取失败：' + PERF_GIFTS); }
}
/* 公演礼物若跟房间/成员直播混在同一个抓取文件里（room:3），这里捞出来喂给公演榜，
   保证它们只出现在公演榜，不出现在成员榜 / 送礼榜 / 礼物榜。
   字段约定：pg=团名（必填，公演聊天室一团一个，靠它归团）、gn=礼物名、其余同普通记录。 */
for (const r of (raw.items || [])) {
  if (Number(r.room) !== PERF_ROOM) continue;
  perfGiftRecords.push({
    t: Number(r.t) || 0, g: r.pg || '', gname: r.gn || r.g, num: Number(r.num) || 0,
    sid: r.sid, sn: r.sn,
  });
}
/* 单价统一按现行价目表重算（弹幕不计鸡腿也在这层生效） */
perfGiftRecords = perfGiftRecords
  .filter((r) => r.g && Number(r.t) >= PERF_SINCE)
  .map((r) => {
    const num = Number(r.num) || 0;
    return { ...r, num, val: num * priceOf(0, r.gname) };
  });
const { aggregateByTeam, teamOf } = await import('./lib/perf.mjs');
const agg = aggregateByTeam(perfPast, perfGiftRecords);
const PERF_GS = ['SNH48', 'GNZ48', 'BEJ48', 'CKG48', 'CGT48'];
// 场次数直接按排期数（不能拿"收到礼物的场次数"顶替，否则没礼物时全是 0）
const perfCount = new Map();
for (const p of perfPast) {
  const k = p.g + '|' + teamOf(p);
  perfCount.set(k, (perfCount.get(k) || 0) + 1);
}
const perfTeams = agg.rows
  .map((r) => {
    const rows = perfPast.filter((p) => p.g === r.group && teamOf(p) === r.team).sort((a, b) => b.st - a.st);
    const evs = rows.slice(0, 40).map((p) => ({ st: p.st, title: p.title, sub: p.sub, pr: p.praise || 0 }));
    const cnt = perfCount.get(r.group + '|' + r.team) || 0;
    const pl = rows.map((p) => p.praise || 0).filter((v) => v > 0);
    const praise = pl.length ? Math.round(pl.reduce((a, b) => a + b, 0) / pl.length) : 0;
    return { g: r.group, team: r.team, perfs: cnt, val: r.val, num: r.num, avg: cnt ? Math.round(r.val / cnt) : 0, praise, evs };
  })
  .filter((t) => t.perfs > 0)
  .sort((a, b) => PERF_GS.indexOf(a.g) - PERF_GS.indexOf(b.g) || b.perfs - a.perfs || b.val - a.val);
const perfGroupCount = {};
for (const t of perfTeams) perfGroupCount[t.g] = (perfGroupCount[t.g] || 0) + 1;

const data = {
  at: raw.at || Date.now(),
  since: raw.since || 0,
  totalVal, totalNum, records: items.length,
  memberCount: members.length, senderCount: senders.length, giftCount: gifts.length,
  members, senders, gifts, groupCount,
  roomRecords: items.filter((r) => Number(r.room) === 1).length,
  liveRecords: items.filter((r) => Number(r.room) === 2).length,
  perf: {
    hasGift: perfGiftRecords.length > 0,
    giftVal: perfTeams.reduce((a, b) => a + b.val, 0),
    matches: perfPast.length,
    last: perfPast[0] ? perfPast[0].st : 0,
    teams: perfTeams,
    groupCount: perfGroupCount,
    future: perfFuture.map((p) => ({ g: p.g, st: p.st, title: p.title, team: teamOf(p) })),
  },
};

const html = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>口袋48 礼物榜 · 鸡腿</title>
<style>
  :root{
    --bg:#f6f6f8; --card:#fff; --tx:#1a1a1c; --tx2:#8e8e93; --tx3:#b8b8bd;
    --line:#ececf0; --p:#5b5bd6; --pb:#eeecfd;
    --gold:#f0b429; --silver:#a7adb9; --bronze:#c98352;
    --safe-b:env(safe-area-inset-bottom); --safe-t:env(safe-area-inset-top);
  }
  *{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    background:var(--bg); color:var(--tx); font-size:15px; line-height:1.45;
    -webkit-font-smoothing:antialiased; -webkit-text-size-adjust:100%;
  }
  button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
  input{font:inherit}
  .top{position:sticky; top:0; z-index:20; background:var(--card); padding:calc(8px + var(--safe-t)) 0 8px; border-bottom:1px solid var(--line)}
  .tbar{max-width:880px; margin:0 auto; padding:0 12px; display:flex; align-items:center; gap:10px}
  .ttl{flex:1; min-width:0}
  .ttl b{display:block; font-size:15.5px; font-weight:700; letter-spacing:.2px}
  .ttl i{display:block; font-size:11.5px; color:var(--tx2); font-style:normal; margin-top:2px}
  .tag{flex-shrink:0; font-size:11px; color:var(--p); font-weight:600; padding:3px 9px; border-radius:12px; background:var(--pb)}
  .wrap{max-width:880px; margin:0 auto; padding:12px 12px calc(40px + var(--safe-b))}
  .stats{display:grid; grid-template-columns:repeat(2,1fr); gap:8px; margin-bottom:12px}
  .stat{background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px}
  .stat .v{font-size:18px; font-weight:800; letter-spacing:-.3px; font-variant-numeric:tabular-nums}
  .stat .k{font-size:11px; color:var(--tx2); margin-top:2px}
  .seg{display:flex; gap:3px; background:#ececf0; border-radius:11px; padding:3px; margin-bottom:9px}
  .seg button{flex:1; padding:8px 4px; border-radius:9px; font-size:13px; font-weight:600; color:var(--tx2); white-space:nowrap}
  .seg button.on{background:var(--card); color:var(--tx); box-shadow:0 1px 3px rgba(0,0,0,.09)}
  .chips{display:flex; gap:6px; overflow-x:auto; padding:0 0 9px; margin:0; -webkit-overflow-scrolling:touch; scrollbar-width:none}
  .chips::-webkit-scrollbar{display:none}
  .chips button{
    flex:0 0 auto; padding:5px 11px; border-radius:14px; background:var(--card);
    border:1px solid var(--line); font-size:12.5px; font-weight:600; color:var(--tx2); white-space:nowrap;
  }
  .chips button.on{background:var(--p); border-color:var(--p); color:#fff}
  .chips button .c{opacity:.55; font-weight:400; margin-left:3px; font-variant-numeric:tabular-nums}
  .si{margin-bottom:10px}
  .si input{width:100%; height:40px; padding:0 13px; border-radius:10px; border:1px solid var(--line); background:var(--card); outline:none}
  .list{background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden}
  .row{display:flex; align-items:center; gap:10px; padding:10px 12px; border-top:1px solid var(--line); width:100%; text-align:left}
  .row:first-child{border-top:0}
  .row.tap{cursor:pointer}
  .row.tap:active{background:#fafafc}
  .rk{flex-shrink:0; width:22px; text-align:center; font-size:13px; font-weight:800; color:var(--tx3); font-variant-numeric:tabular-nums}
  .rk.g1{color:var(--gold)} .rk.g2{color:var(--silver)} .rk.g3{color:var(--bronze)}
  .av{flex-shrink:0; width:34px; height:34px; border-radius:17px; background:var(--pb); color:var(--p); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; overflow:hidden}
  .mn{flex:1; min-width:0}
  .mn b{display:block; font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .mn i{display:block; font-size:11px; color:var(--tx2); font-style:normal; margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .vl{flex-shrink:0; text-align:right}
  .vl b{display:block; font-size:15px; font-weight:800; font-variant-numeric:tabular-nums; letter-spacing:-.2px}
  .vl i{display:block; font-size:10.5px; color:var(--tx2); font-style:normal; font-variant-numeric:tabular-nums}
  .go{flex-shrink:0; width:14px; text-align:center; color:var(--tx3); font-size:15px}
  .row.tap:hover .go{color:var(--p)}
  .empty{padding:26px 12px; text-align:center; color:var(--tx3); font-size:13px}
  .sheet{position:fixed; inset:0; z-index:50; display:none}
  .sheet.on{display:block}
  .mask{position:absolute; inset:0; background:rgba(0,0,0,.35)}
  .panel{position:absolute; left:0; right:0; bottom:0; max-height:82vh; background:var(--card); border-radius:16px 16px 0 0; display:flex; flex-direction:column; padding-bottom:var(--safe-b)}
  .ph{display:flex; align-items:center; gap:10px; padding:14px 14px 10px; border-bottom:1px solid var(--line)}
  .ph b{flex:1; font-size:15.5px; font-weight:700}
  .ph .x{width:28px; height:28px; border-radius:14px; background:var(--bg); color:var(--tx2); font-size:16px; line-height:1}
  .pb{overflow-y:auto; -webkit-overflow-scrolling:touch; padding:10px 14px 18px}
  .sec{font-size:12px; font-weight:700; color:var(--tx2); margin:12px 0 6px}
  .sec:first-child{margin-top:2px}
  .li{display:flex; align-items:center; gap:8px; padding:7px 0; font-size:13px; border-bottom:1px solid var(--line)}
  .li:last-child{border-bottom:0}
  .li .n{flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
  .li .q{color:var(--tx2); font-size:12px; flex-shrink:0; font-variant-numeric:tabular-nums}
  .li .m{font-weight:700; flex-shrink:0; font-variant-numeric:tabular-nums; min-width:52px; text-align:right}
  .foot{text-align:center; color:var(--tx3); font-size:11px; padding:16px 0 4px}
</style>
</head>
<body>
<div class="top">
  <div class="tbar">
    <div class="ttl"><b>口袋48 礼物榜</b><i id="sub"></i></div>
    <span class="tag">鸡腿</span>
  </div>
</div>
<div class="wrap">
  <div class="stats">
    <div class="stat"><div class="v" id="s1">-</div><div class="k" id="k1">总鸡腿</div></div>
    <div class="stat"><div class="v" id="s2">-</div><div class="k" id="k2">送礼人数</div></div>
    <div class="stat"><div class="v" id="s3">-</div><div class="k" id="k3">礼物件数</div></div>
    <div class="stat"><div class="v" id="s4">-</div><div class="k" id="k4">收到礼物的成员</div></div>
  </div>
  <div class="seg">
    <button data-t="m" class="on">成员榜</button>
    <button data-t="s">送礼榜</button>
    <button data-t="g">礼物榜</button>
    <button data-t="p">公演榜</button>
  </div>
  <div class="chips" id="chips"></div>
  <div class="si"><input id="q" type="search" placeholder="搜成员 / 粉丝 / 礼物" autocomplete="off"></div>
  <div class="list" id="list"></div>
  <div class="foot" id="foot"></div>
</div>
<div class="sheet" id="sheet">
  <div class="mask" data-close></div>
  <div class="panel">
    <div class="ph"><b id="sh-t"></b><button class="x" data-close>×</button></div>
    <div class="pb" id="sh-b"></div>
  </div>
</div>
<script>window.LV_DATA=__DATA__;</script>
<script>
(function(){
  var D = window.LV_DATA;
  var BJ = 8*3600e3;
  var GROUPS = ['SNH48','GNZ48','BEJ48','CKG48','CGT48','IDFT','其他'];
  var GCLS = [
    { k:'all',  n:'全部' },
    { k:'wand', n:'荧光棒' },
    { k:'low',  n:'10~48' },
    { k:'mid',  n:'100~1500' },
    { k:'high', n:'2880+' },
    { k:'act',  n:'不计价' },
  ];
  function nf(n){ return Number(n||0).toLocaleString('zh-CN'); }
  function hhmm(t){ var d=new Date(t+BJ); return ('0'+d.getUTCHours()).slice(-2)+':'+('0'+d.getUTCMinutes()).slice(-2); }
  function day(ts){ var d=new Date(ts+BJ); return d.getUTCFullYear()+'-'+('0'+(d.getUTCMonth()+1)).slice(-2)+'-'+('0'+d.getUTCDate()).slice(-2); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }
  function cls(v){ if(!v) return 'act'; if(v<=5) return 'wand'; if(v<100) return 'low'; if(v<2000) return 'mid'; return 'high'; }

  function paintStats(){
    var p = D.perf || { teams: [], matches: 0, giftVal: 0 };
    document.getElementById('s1').textContent = nf(D.totalVal);
    document.getElementById('s2').textContent = nf(D.senderCount);
    document.getElementById('s3').textContent = nf(D.totalNum);
    document.getElementById('s4').textContent = nf(D.memberCount);
    document.getElementById('sub').textContent = day(D.at) + ' · ' + D.records + ' 条记录 · 更新 ' + hhmm(D.at);
    document.getElementById('foot').textContent = '房间 ' + D.roomRecords + ' 条 · 直播 ' + D.liveRecords + ' 条';
    document.getElementById('k1').textContent = '总鸡腿';
    document.getElementById('k2').textContent = '送礼人数';
    document.getElementById('k3').textContent = '礼物件数';
    document.getElementById('k4').textContent = '收到礼物的成员';
  }
  function paintPerfStats(){
    var p = D.perf || { teams: [], matches: 0, giftVal: 0, future: [] };
    document.getElementById('s1').textContent = p.hasGift ? nf(p.giftVal) : '—';
    document.getElementById('s2').textContent = nf(p.matches);
    document.getElementById('s3').textContent = nf(p.teams.length);
    document.getElementById('s4').textContent = nf((p.future||[]).length);
    document.getElementById('sub').textContent = '官方公演直播 · 10-24 起 · 场次至 ' + (p.last ? day(p.last) : '—');
    document.getElementById('foot').textContent = p.hasGift
      ? '公演直播间礼物已接入 · 按场次时间窗归队伍'
      : '公演礼物需常驻监听接入 · 当前只有排期 / 场次 / 点赞';
    document.getElementById('k1').textContent = '公演鸡腿';
    document.getElementById('k2').textContent = '统计场次';
    document.getElementById('k3').textContent = '队伍数';
    document.getElementById('k4').textContent = '待开播';
  }

  var TAB = 'm';
  var FILT = 'all';

  function paintChips(){
    var box = document.getElementById('chips');
    var h = '';
    if (TAB === 'm') {
      h += '<button data-f="all"' + (FILT==='all'?' class="on"':'') + '>全部<span class="c">' + D.memberCount + '</span></button>';
      for (var i=0;i<GROUPS.length;i++){
        var g = GROUPS[i], c = D.groupCount[g] || 0;
        if (!c) continue;
        h += '<button data-f="' + g + '"' + (FILT===g?' class="on"':'') + '>' + g + '<span class="c">' + c + '</span></button>';
      }
    } else if (TAB === 'g') {
      for (var j=0;j<GCLS.length;j++){
        var it = GCLS[j];
        var c2 = 0;
        for (var k=0;k<D.gifts.length;k++) if (it.k === 'all' || cls(D.gifts[k].v) === it.k) c2++;
        if (!c2 && it.k !== 'all') continue;
        h += '<button data-f="' + it.k + '"' + (FILT===it.k?' class="on"':'') + '>' + it.n + '<span class="c">' + c2 + '</span></button>';
      }
    } else if (TAB === 'p') {
      var PG = ['SNH48','GNZ48','BEJ48','CKG48','CGT48'];
      h += '<button data-f="all"' + (FILT==='all'?' class="on"':'') + '>全部<span class="c">' + D.perf.teams.length + '</span></button>';
      for (var p1=0;p1<PG.length;p1++){
        var pg = PG[p1], pc = D.perf.groupCount[pg] || 0;
        if (!pc) continue;
        h += '<button data-f="' + pg + '"' + (FILT===pg?' class="on"':'') + '>' + pg + '<span class="c">' + pc + '</span></button>';
      }
    }
    box.innerHTML = h;
    box.style.display = (TAB === 's') ? 'none' : 'flex';
  }

  function render(){
    var q = document.getElementById('q').value.trim().toLowerCase();
    var box = document.getElementById('list');
    var html = '', i, x, arr;
    if (TAB === 'm') {
      arr = D.members.filter(function(y){
        if (FILT !== 'all' && y.g !== FILT) return false;
        return !q || String(y.n).toLowerCase().indexOf(q) >= 0;
      });
      if (!arr.length) { box.innerHTML = '<div class="empty">没有匹配</div>'; return; }
      for (i=0;i<arr.length;i++){
        x = arr[i];
        var sub = x.g + (x.t && x.t !== x.g ? ' · ' + x.t : '') + ' · ' + x.cnt + ' 次 · ' + x.num + ' 件';
        html += '<button class="row tap" data-mid="'+x.id+'">'
          + '<span class="rk'+(i<3?' g'+(i+1):'')+'">'+(i+1)+'</span>'
          + '<span class="av">'+esc(String(x.n).slice(0,1))+'</span>'
          + '<span class="mn"><b>'+esc(x.n)+'</b><i>'+esc(sub)+'</i></span>'
          + '<span class="vl"><b>'+nf(x.val)+'</b><i>鸡腿</i></span>'
          + '<span class="go">›</span></button>';
      }
    } else if (TAB === 's') {
      arr = D.senders.filter(function(y){ return !q || String(y.n).toLowerCase().indexOf(q) >= 0; });
      if (!arr.length) { box.innerHTML = '<div class="empty">没有匹配</div>'; return; }
      for (i=0;i<arr.length;i++){
        x = arr[i];
        html += '<div class="row">'
          + '<span class="rk'+(i<3?' g'+(i+1):'')+'">'+(i+1)+'</span>'
          + '<span class="av">'+esc(String(x.n).slice(0,1))+'</span>'
          + '<span class="mn"><b>'+esc(x.n)+'</b><i>'+x.cnt+' 次 · 送给 '+x.to+' 位成员</i></span>'
          + '<span class="vl"><b>'+nf(x.val)+'</b><i>鸡腿</i></span></div>';
      }
    } else if (TAB === 'p') {
      arr = D.perf.teams.filter(function(y){
        if (FILT !== 'all' && y.g !== FILT) return false;
        return !q || String(y.g + y.team).toLowerCase().indexOf(q) >= 0;
      });
      if (!arr.length) { box.innerHTML = '<div class="empty">没有匹配</div>'; return; }
      for (i=0;i<arr.length;i++){
        x = arr[i];
        var sub2 = x.g + ' · ' + x.perfs + ' 场' + (x.praise ? ' · 场均 👍' + x.praise : '') + (D.perf.hasGift ? ' · 场均 ' + nf(x.avg) + ' 鸡腿' : '');
        html += '<button class="row tap" data-team="'+esc(x.g+'|'+x.team)+'">'
          + '<span class="rk'+(i<3?' g'+(i+1):'')+'">'+(i+1)+'</span>'
          + '<span class="av">'+esc(String(x.team).slice(0,1))+'</span>'
          + '<span class="mn"><b>'+esc(x.team)+'</b><i>'+esc(sub2)+'</i></span>'
          + '<span class="vl"><b>'+(D.perf.hasGift ? nf(x.val) : '—')+'</b><i>鸡腿</i></span>'
          + '<span class="go">›</span></button>';
      }
    } else {
      arr = D.gifts.filter(function(y){
        if (FILT !== 'all' && cls(y.v) !== FILT) return false;
        return !q || String(y.g).toLowerCase().indexOf(q) >= 0;
      });
      if (!arr.length) { box.innerHTML = '<div class="empty">没有匹配</div>'; return; }
      for (i=0;i<arr.length;i++){
        x = arr[i];
        html += '<div class="row">'
          + '<span class="rk'+(i<3?' g'+(i+1):'')+'">'+(i+1)+'</span>'
          + '<span class="av">'+esc(String(x.g).slice(0,1))+'</span>'
          + '<span class="mn"><b>'+esc(x.g)+'</b><i>'+x.num+' 个 × '+(x.v ? x.v : '不计价')+' · '+x.to+' 位成员</i></span>'
          + '<span class="vl"><b>'+(x.v ? nf(x.val) : '—')+'</b><i>鸡腿</i></span></div>';
      }
    }
    box.innerHTML = html;
  }

  document.querySelector('.seg').addEventListener('click', function(e){
    var b = e.target.closest('button[data-t]'); if (!b) return;
    TAB = b.getAttribute('data-t');
    FILT = 'all';
    [].forEach.call(document.querySelectorAll('.seg button'), function(x){ x.classList.toggle('on', x === b); });
    document.getElementById('q').placeholder = (TAB === 'p') ? '搜队伍 / 团' : '搜成员 / 粉丝 / 礼物';
    if (TAB === 'p') paintPerfStats(); else paintStats();
    paintChips();
    render();
  });

  document.getElementById('chips').addEventListener('click', function(e){
    var b = e.target.closest('button[data-f]'); if (!b) return;
    FILT = b.getAttribute('data-f');
    paintChips();
    render();
  });

  document.getElementById('q').addEventListener('input', render);

  var sheet = document.getElementById('sheet');
  document.getElementById('list').addEventListener('click', function(e){
    var tr = e.target.closest('[data-team]');
    if (tr) {
      var key = tr.getAttribute('data-team');
      var t = D.perf.teams.filter(function(x){ return (x.g + '|' + x.team) === key; })[0];
      if (!t) return;
      document.getElementById('sh-t').textContent = t.team + (D.perf.hasGift ? ' · ' + nf(t.val) + ' 鸡腿' : '');
      var hh = '<div class="sec">' + t.g + ' · ' + t.perfs + ' 场' + (D.perf.hasGift ? ' · 场均 ' + nf(t.avg) + ' 鸡腿' : ' · 礼物待接入') + '</div>';
      for (var k=0;k<t.evs.length;k++){
        var ev = t.evs[k];
        hh += '<div class="li"><span class="n">' + esc(ev.title || '公演') + '</span><span class="q">' + day(ev.st) + '</span></div>';
      }
      document.getElementById('sh-b').innerHTML = hh;
      sheet.classList.add('on');
      return;
    }
    var r = e.target.closest('[data-mid]'); if (!r) return;
    var m = D.members.filter(function(x){ return String(x.id) === r.getAttribute('data-mid'); })[0];
    if (!m) return;
    document.getElementById('sh-t').textContent = m.n + ' · ' + nf(m.val) + ' 鸡腿';
    var h = '<div class="sec">送礼粉丝（'+m.senders.length+'）</div>';
    for (var i=0;i<m.senders.length;i++){
      var s = m.senders[i];
      h += '<div class="li"><span class="n">'+esc(s.n)+'</span><span class="q">'+s.num+' 件</span><span class="m">'+nf(s.val)+'</span></div>';
    }
    h += '<div class="sec">礼物构成</div>';
    for (var j=0;j<m.gifts.length;j++){
      var g = m.gifts[j];
      h += '<div class="li"><span class="n">'+esc(g.g)+'</span><span class="q">'+g.num+' 个 × '+(g.v||'?')+'</span><span class="m">'+nf(g.val)+'</span></div>';
    }
    document.getElementById('sh-b').innerHTML = h;
    sheet.classList.add('on');
  });
  sheet.addEventListener('click', function(e){ if (e.target.hasAttribute('data-close')) sheet.classList.remove('on'); });

  paintStats();
  paintChips();
  render();
})();
</script>
</body>
</html>`;

writeFileSync(OUT, html.replace('__DATA__', JSON.stringify(data)));
console.log('成员 ' + members.length + ' / 送礼人 ' + senders.length + ' / 礼物 ' + gifts.length);
console.log('总鸡腿 ' + totalVal + ' / 件数 ' + totalNum + ' / 记录 ' + items.length);
console.log('团分布 ' + JSON.stringify(groupCount));
console.log('→ ' + OUT);
