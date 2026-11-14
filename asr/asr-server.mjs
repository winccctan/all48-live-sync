/* 口袋房间语音 → 文字 · 本地转写服务（2026-11-14）
 *
 * 站长问：「能语音直接转文字吗」。之前成员发翻牌语音，微信里只有一行类型标记，
 * 等于什么都没收到。现在用本机模型转成中文再推，不调任何第三方 API。
 *
 * 为什么是 Paraformer 而不是 whisper：中文场景 Paraformer（阿里达摩院）短语音识别
 * 明显更准，int8 模型 230MB，8 核 CPU 上 7 秒语音约 0.3–1 秒出字；whisper small 中文
 * 常把「品鉴」听成「品见」这类同音错，还慢。
 *
 * 形态：常驻 HTTP 服务，只听 127.0.0.1:8799，只有同一台机器上的 client.mjs 能调。
 *   POST /asr  {"url":"https://mp4-new1.48.cn/....aac"}  →  {"ok":1,"text":"…"}
 *   GET  /ping                                          →  {"ok":1,"ready":true}
 *
 * 🔴 结果按音频 URL 缓存（/app/asr/cache/<md5>.txt）：Actions 和长连接两条通道
 *    会重复看到同一条语音，缓存命中直接返回，不重复烧 CPU。
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const require = createRequire('/app/asr/');
const sherpa = require('sherpa-onnx-node');

const MODEL_DIR = process.env.ASR_MODEL || '/app/asr/models/sherpa-onnx-paraformer-zh-2023-09-14';
const CACHE_DIR = '/app/asr/cache';
const TMP_DIR = '/app/asr/tmp';
const PORT = Number(process.env.ASR_PORT) || 8799;
const MAX_MS = Number(process.env.ASR_MAX_MS) || 90e3;   // 超过 90 秒的音频不转（房间语音不该这么长）

mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- 模型：懒加载，只加载一次 ---------- */
let rec = null;
function recognizer() {
  if (rec) return rec;
  const t0 = Date.now();
  rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: {
        model: MODEL_DIR + '/model.int8.onnx',
        tokens: MODEL_DIR + '/tokens.txt',
      },
      tokens: MODEL_DIR + '/tokens.txt',
      numThreads: 4,
      provider: 'cpu',
      debug: 0,
      modelType: 'paraformer',
    },
  });
  log(`模型已加载 ${Date.now() - t0}ms`);
  return rec;
}

const run = (cmd, args, ms) => new Promise((res, rej) => {
  execFile(cmd, args, { timeout: ms || 30000, maxBuffer: 1 << 22 }, (e, so, se) => {
    if (e) rej(new Error(String((se || e.message || e)).slice(0, 200)));
    else res(so);
  });
});

/** 任意音频 → 16k 单声道 float32 PCM（微信/口袋给的是 aac，直接喂 ffmpeg） */
async function toRaw(input, out) {
  await run('ffmpeg', ['-y', '-v', 'error', '-i', input, '-ac', '1', '-ar', '16000',
    '-f', 'f32le', '-acodec', 'pcm_f32le', out], 45000);
  const buf = readFileSync(out);
  if (buf.length < 3200) throw new Error('audio_too_short');     // <0.05 秒
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2);
}

async function transcribeUrl(url) {
  const key = createHash('md5').update(String(url)).digest('hex').slice(0, 24);
  const hit = CACHE_DIR + '/' + key + '.txt';
  if (existsSync(hit)) {
    const t = readFileSync(hit, 'utf8');
    if (t.trim()) return { text: t, cached: true };
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('dl_http_' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 512) throw new Error('audio_empty');
  const src = TMP_DIR + '/' + key + '.bin';
  const raw = TMP_DIR + '/' + key + '.f32';
  writeFileSync(src, buf);
  const samples = await toRaw(src, raw);
  const dur = Math.round(samples.length / 16000 * 10) / 10;
  const st = recognizer().createStream();
  st.acceptWaveform({ samples, sampleRate: 16000 });
  const res = await recognizer().decodeAsync(st);
  const text = String((res && res.text) || '').replace(/\s+/g, ' ').trim();
  if (text) writeFileSync(hit, text, 'utf8');
  try { const { unlinkSync } = await import('node:fs'); unlinkSync(src); unlinkSync(raw); } catch { /* 忽略 */ }
  return { text, dur, cached: false };
}

/* ---------- 串行队列：模型不是线程安全的，宁可排队也不并发 ---------- */
let chain = Promise.resolve();
const enqueue = (fn) => {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
};

const json = (res, obj, code) => {
  const s = JSON.stringify(obj);
  res.writeHead(code || 200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/ping')) return json(res, { ok: 1, ready: !!rec });
  if (req.method === 'POST' && req.url.startsWith('/asr')) {
    let body = '';
    try {
      for await (const c of req) { body += c; if (body.length > 4000) break; }
      const j = JSON.parse(body || '{}');
      const url = String(j.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return json(res, { ok: 0, e: 'bad_url' }, 400);
      if (j.ms && Number(j.ms) > MAX_MS) return json(res, { ok: 0, e: 'too_long' }, 400);
      const t0 = Date.now();
      const r = await enqueue(() => transcribeUrl(url));
      log(`转写 ${r.cached ? '命中' : '完成'} ${Date.now() - t0}ms ${r.dur ? r.dur + 's ' : ''}${(r.text || '').slice(0, 40)}`);
      return json(res, { ok: 1, text: r.text, dur: r.dur || 0, cached: !!r.cached, ms: Date.now() - t0 });
    } catch (e) {
      const m = String((e && e.message) || e).slice(0, 160);
      log('转写失败：' + m);
      return json(res, { ok: 0, e: m }, 200);
    }
  }
  return json(res, { ok: 0, e: 'not_found' }, 404);
}).listen(PORT, '127.0.0.1', () => log(`ASR 服务就绪 127.0.0.1:${PORT}（模型 ${MODEL_DIR}）`));
