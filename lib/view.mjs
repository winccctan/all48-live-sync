/**
 * 口袋48 消息 → 站点视图
 *
 * 实测结论（2026-10-14）：口袋消息的 `bodys` 与 msg48 的 `content` 完全同构、
 * `msgType` 与 msg48 的 `msg_type` 一致 —— 所以这里沿用站点侧同一套映射规则，
 * 抓取端就把结构转好存进 KV，Worker 只管拼装，不在请求路径上做转换。
 *
 * 输出形状：{ t, k, x, i, r, c, a, v }
 *   t 时间戳(ms) · k 原类型 · x 文本 · i 图片[] · r 引用[名, 内容] · c 卡片[标签, 标题, 图] · a 音频 · v 视频
 */

const BASE_IMG = 'https://source3.48.cn';
const BASE_MEDIA = 'https://mp4.48.cn';

function mediaUrl(p) {
  if (!p) return '';
  if (/^(https?|data):/i.test(p)) return p;
  if (/^\/\//.test(p)) return 'https:' + p;
  const full = p.charAt(0) === '/' ? p : '/' + p;
  return (/\.(aac|mp3|m4a|wav|mp4|mov|m4v|m3u8)(\?|$)/i.test(full) ? BASE_MEDIA : BASE_IMG) + full;
}

const TYPE_LABEL = {
  LIVEPUSH: '开播提醒', OPEN_LIVE: '开播提醒',
  SHARE_POSTS: '分享',
  GIFT_TEXT: '礼物',
  AGENT_QCHAT_TEXT: 'AI 对话', AGENT_QCHAT_TEXT_REPLY: 'AI 对话',
  AGENT_QCHAT_GIFT_REPLY: 'AI 对话回复',
  FLIPCARD_AUDIO: '翻牌 · 语音', FLIPCARD_VIDEO: '翻牌 · 视频',
  AUDIO_GIFT_REPLY: '礼物语音回复',
  VIDEO: '视频', AUDIO: '语音', IMAGE: '图片',
};

/** 口袋原始消息 → 视图 */
export function pocketToView(m) {
  const ts = Number(m.msgTime) || 0;
  const type = String(m.msgType || 'TEXT');
  const o = { t: ts, k: type, x: '', i: null, r: null, c: null, a: '', v: '' };
  const raw = m.bodys;

  if (type === 'TEXT' || typeof raw !== 'string') {
    o.x = raw == null ? '' : String(raw);
    return o;
  }

  let ct = null;
  try { ct = JSON.parse(raw); } catch (e) { o.x = raw; return o; }
  if (!ct || typeof ct !== 'object') { o.x = raw; return o; }

  const flipAnswer = (fi) => {
    let ans = fi.answer;
    if (typeof ans === 'string' && ans.charAt(0) === '{') {
      try { ans = JSON.parse(ans); } catch (e) { /* 保持原样 */ }
    }
    return ans;
  };

  switch (type) {
    case 'IMAGE':
      if (ct.url) o.i = [mediaUrl(ct.url)];
      break;

    case 'EXPRESSIMAGE':
    case 'EXPRESS': {
      const e = ct.expressImgInfo || ct.expressInfo || ct;
      if (e.emotionRemote || e.url) o.i = [mediaUrl(e.emotionRemote || e.url)];
      break;
    }

    case 'REPLY': {
      const r = ct.replyInfo || {};
      o.x = r.text || '';
      if (r.replyName || r.replyText) o.r = [r.replyName || '', r.replyText || ''];
      if (r.voiceUrl) o.a = mediaUrl(r.voiceUrl);
      break;
    }

    case 'GIFTREPLY': {
      const g = ct.giftReplyInfo || {};
      o.x = g.text || '';
      if (g.replyName || g.replyText) o.r = [g.replyName || '', g.replyText || ''];
      if (g.voiceUrl) o.a = mediaUrl(g.voiceUrl);
      break;
    }

    case 'AUDIO_GIFT_REPLY': {
      const g = ct.giftReplyInfo || {};
      o.x = g.text || '';
      if (g.replyName || g.replyText) o.r = [g.replyName || '', g.replyText || ''];
      if (g.voiceUrl || g.url) o.a = mediaUrl(g.voiceUrl || g.url);
      break;
    }

    case 'AUDIO':
      o.a = mediaUrl(ct.url || ct.voiceUrl);
      break;

    case 'VIDEO': {
      o.v = mediaUrl(ct.url || ct.videoUrl || ct.playUrl);
      const cover = ct.cover || ct.coverPath || ct.coverUrl;
      if (cover) o.i = [mediaUrl(cover)];
      break;
    }

    case 'FLIPCARD': {
      const f = ct.filpCardInfo || {};
      o.x = typeof f.answer === 'string' ? f.answer : '';
      if (f.question) o.r = ['翻牌提问', f.question];
      break;
    }

    case 'FLIPCARD_AUDIO':
    case 'FLIPCARD_VIDEO': {
      const f = ct.filpCardInfo || {};
      const ans = flipAnswer(f);
      if (ans && typeof ans === 'object' && ans.url) {
        if (type === 'FLIPCARD_VIDEO') o.v = mediaUrl(ans.url);
        else o.a = mediaUrl(ans.url);
      } else if (typeof ans === 'string') {
        o.x = ans;
      }
      if (f.question) o.r = ['翻牌提问', f.question];
      break;
    }

    case 'LIVEPUSH':
    case 'OPEN_LIVE': {
      const l = ct.livePushInfo || ct;
      o.c = ['直播', l.liveTitle || l.title || '开播啦', mediaUrl(l.liveCover || l.cover)];
      break;
    }

    case 'SHARE_POSTS': {
      const s = ct.shareInfo || ct;
      o.c = ['分享', s.shareTitle || s.title || '分享', mediaUrl(s.sharePic || s.pic)];
      break;
    }

    default: {
      if (/^RED_PACKET/.test(type)) {
        o.c = ['红包', ct.blessMessage || '红包', mediaUrl(ct.coverUrl || ct.openImgUrl)];
      } else if (ct.text || ct.content) {
        o.x = String(ct.text || ct.content);
      } else if (ct.url) {
        o.i = [mediaUrl(ct.url)];
      } else {
        o.x = TYPE_LABEL[type] || '';
      }
    }
  }

  if (!o.x && !o.i && !o.r && !o.c && !o.a && !o.v) o.x = TYPE_LABEL[type] || '';
  return o;
}

/** extInfo 解析：判断这条是不是「她本人」发的（channelRole=2 才是偶像本人，0 是粉丝） */
export function parseExt(m) {
  try {
    const e = typeof m.extInfo === 'string' ? JSON.parse(m.extInfo) : m.extInfo;
    return e && typeof e === 'object' ? e : {};
  } catch (e) { return {}; }
}

export function isOwnerMsg(m, ownerId) {
  const e = parseExt(m);
  const role = Number(e.channelRole);
  const uid = e.user && Number(e.user.userId);
  if (role === 2) return true;                    // 偶像本人
  return !!ownerId && uid === Number(ownerId) && role !== 0;
}
