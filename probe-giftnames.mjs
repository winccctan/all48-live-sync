/**
 * 一次性探针：把礼品价目表整棵树挖干净，找出「弦月回响」的 giftId
 *
 * 前两次都栽在「猜层级」上：接口返回的 content 不是数组、也不是 {giftList:[]}，
 * 而是 { "0": [...], "1": [...], "2": [...] } 这种分组套数组的结构。
 * 这次不再猜 —— 递归遍历整棵 JSON，凡是对象里带 giftName / name 的节点都算礼物，全捞出来。
 *
 * 拿到 giftId 之后填进 worker 的 GIFT_IDS：活动礼物会改名，id 不会；
 * 而且 888xxx 那批是「活动打分道具」，用完就下架、下次活动换名字，必须靠 id 分辨。
 */
import { postJson } from './lib/api.mjs';

const TOKEN = process.env.POCKET48_TOKEN || '';
if (!TOKEN) { console.error('缺少 POCKET48_TOKEN'); process.exit(1); }

/** 递归收集所有「看起来像礼物」的节点 */
function collect(node, out, path, depth) {
  if (depth > 8 || node == null) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collect(v, out, path + '[' + i + ']', depth + 1));
    return;
  }
  if (typeof node !== 'object') return;

  const name = node.giftName || node.name || node.gift_name;
  const id = node.giftId || node.id || node.gift_id;
  if (name != null && id != null && String(name).length && String(id).length) {
    out.push({
      path,
      id: String(id),
      name: String(name),
      keys: Object.keys(node),
      node,
    });
  }
  for (const k of Object.keys(node)) {
    if (k === 'giftName' || k === 'name') continue;
    collect(node[k], out, path + '.' + k, depth + 1);
  }
}

const seenPath = new Set();

async function dump(label, body) {
  console.log('\n===== /gift/api/v1/gift/list  body=' + JSON.stringify(body));
  let d = null;
  try {
    d = await postJson('/gift/api/v1/gift/list', body, { token: TOKEN, retries: 1 });
  } catch (e) {
    console.log('  失败 ' + String((e && e.message) || e).slice(0, 200));
    return;
  }
  console.log('  status=' + (d && d.status) + ' msg=' + (d && d.msg));
  const out = [];
  collect(d && d.content, out, 'content', 0);
  console.log('  递归挖出礼物节点 ' + out.length + ' 个');

  const uniq = new Map();
  for (const g of out) uniq.set(g.id + '|' + g.name, g);
  const list = [...uniq.values()];
  if (list.length) {
    console.log('  节点字段样例 ' + JSON.stringify(list[0].keys));
    console.log('  路径样例 ' + list[0].path);
  }

  const hit = list.filter((g) => /弦月|回响|弦/.test(g.name));
  if (hit.length) {
    for (const g of hit) {
      console.log('  ★★★ 命中 ' + JSON.stringify({ id: g.id, name: g.name, path: g.path, node: g.node }));
    }
  } else {
    console.log('  ✗ 没有含「弦月 / 回响 / 弦」的礼物');
  }

  const names = list.map((g) => g.name + '(' + g.id + ')');
  console.log('  全部 ' + names.length + ' 个：');
  for (let i = 0; i < names.length; i += 6) console.log('    ' + names.slice(i, i + 6).join('  '));
  seenPath.add(label);
}

await dump('{}', {});
await dump('giftType1', { giftType: 1 });

// 顺手把原始 JSON 头 800 字符打出来，下次再猜层级就有依据了
try {
  const d = await postJson('/gift/api/v1/gift/list', {}, { token: TOKEN, retries: 1 });
  console.log('\n===== 原始 content 头 1200 字符 =====');
  console.log(JSON.stringify(d && d.content).slice(0, 1200));
} catch (e) { /* ignore */ }
