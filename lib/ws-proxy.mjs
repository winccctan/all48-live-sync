/**
 * 让 NIM SDK 的长连接走 HTTP 代理（CONNECT 隧道）
 *
 * 为什么需要：
 *   口袋48 的云信聊天室长连接在**海外出口**进房必被拒（403）。
 *   但国内还有个 HTTP 代理可用（SCRAPE_PROXY，出口是杭州阿里云）。
 *   SDK 内部用的是浏览器式 `new WebSocket(url)`，Node 的全局 WebSocket 不走代理，
 *   所以这里把 globalThis.WebSocket 换成一个「底层用 ws + HttpsProxyAgent」的替身：
 *   每个连接都先跟代理建立 CONNECT 隧道，再从隧道里做 TLS + WS 握手。
 *
 * 实测（2026-10-24，经 home-jp 代理）：
 *   weblink01 / chatweblink01 / hkpxy0 / weblinkoutsea01 的 WS 握手全部成功；
 *   link-ga-hz 反而不通（它要的是纯国内直连，隧道里握手会断）。
 *
 * 替身要兼容浏览器 WebSocket 的常用表面（SDK 是按浏览器写的）：
 *   构造 (url, protocols) / readyState 四态 / binaryType / onopen·onmessage·onerror·onclose
 *   / addEventListener·removeEventListener / send / close / 静态 CONNECTING~CLOSED
 */
import WS from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

export const wsStat = {
  created: 0,
  opens: 0,
  errors: 0,
  closes: 0,
  lastError: '',
  lastAt: 0,
};

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

let installed = null;

/**
 * @param {string} proxyUrl  形如 https://user:pass@host:8443
 * @param {(msg:string)=>void} [log]
 */
export function installProxyWebSocket(proxyUrl, log = () => {}) {
  if (installed) return installed;
  if (!proxyUrl) throw new Error('installProxyWebSocket 需要代理地址');

  const agent = new HttpsProxyAgent(proxyUrl);
  const Real = WS;

  class ProxiedWebSocket {
    constructor(url, protocols) {
      this.url = String(url || '');
      this.readyState = CONNECTING;
      this.binaryType = 'arraybuffer';
      this.bufferedAmount = 0;
      this.extensions = '';
      this.protocol = '';
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._ls = { open: new Set(), message: new Set(), error: new Set(), close: new Set() };
      this._sock = null;

      wsStat.created++;
      wsStat.lastAt = Date.now();
      const self = this;

      let sock;
      try {
        const opts = {
          agent,
          handshakeTimeout: 15000,
          perMessageDeflate: false,
          followRedirects: false,
        };
        sock = (typeof protocols === 'string' || Array.isArray(protocols))
          ? new Real(this.url, protocols, opts)
          : new Real(this.url, opts);
      } catch (e) {
        wsStat.errors++;
        wsStat.lastError = 'construct: ' + String(e && e.message).slice(0, 120);
        queueMicrotask(() => self._fail(e));
        return;
      }
      this._sock = sock;

      sock.on('open', () => {
        self.readyState = OPEN;
        self.protocol = sock.protocol || '';
        self.extensions = sock.extensions || '';
        wsStat.opens++;
        self._emit('open', { type: 'open', target: self });
      });

      sock.on('message', (data, isBinary) => {
        let payload;
        if (!isBinary && Buffer.isBuffer(data)) {
          payload = data.toString('utf8');
        } else if (self.binaryType === 'arraybuffer') {
          payload = (data instanceof ArrayBuffer)
            ? data
            : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else {
          payload = data;
        }
        self._emit('message', { type: 'message', data: payload, target: self });
      });

      sock.on('close', (code, reason) => {
        self.readyState = CLOSED;
        wsStat.closes++;
        self._emit('close', {
          type: 'close',
          code,
          reason: reason ? reason.toString() : '',
          wasClean: code === 1000,
          target: self,
        });
      });

      sock.on('error', (e) => {
        wsStat.errors++;
        wsStat.lastError = String((e && e.message) || e).slice(0, 160);
        if (log) log(`[ws] 连接错误 ${wsStat.lastError}`);
        self._emit('error', { type: 'error', message: wsStat.lastError, error: e, target: self });
      });
    }

    _emit(type, ev) {
      const h = this['on' + type];
      if (typeof h === 'function') {
        try { h.call(this, ev); } catch (e) { /* 回调抛错不能影响连接 */ }
      }
      const set = this._ls[type];
      if (set) for (const fn of set) { try { fn.call(this, ev); } catch { /* noop */ } }
    }

    _fail(e) {
      this.readyState = CLOSED;
      this._emit('error', { type: 'error', message: String((e && e.message) || e), error: e, target: this });
      this._emit('close', { type: 'close', code: 1006, reason: 'construct failed', wasClean: false, target: this });
    }

    addEventListener(type, fn) {
      const set = this._ls[type];
      if (set && typeof fn === 'function') set.add(fn);
    }

    removeEventListener(type, fn) {
      const set = this._ls[type];
      if (set) set.delete(fn);
    }

    send(data) {
      if (!this._sock || this.readyState !== OPEN) return;
      try {
        if (typeof data === 'string' || Buffer.isBuffer(data)) this._sock.send(data);
        else if (data instanceof ArrayBuffer) this._sock.send(Buffer.from(data));
        else if (ArrayBuffer.isView(data)) this._sock.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        else this._sock.send(data);
      } catch (e) {
        wsStat.errors++;
        wsStat.lastError = 'send: ' + String(e.message).slice(0, 100);
      }
    }

    close(code, reason) {
      if (this.readyState === CLOSING || this.readyState === CLOSED) return;
      this.readyState = CLOSING;
      try { this._sock && this._sock.close(code, reason); } catch { /* noop */ }
    }
  }

  for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
    ProxiedWebSocket[k] = v;
    ProxiedWebSocket.prototype[k] = v;
  }
  ProxiedWebSocket.__all48Proxy = true;

  installed = ProxiedWebSocket;
  globalThis.WebSocket = ProxiedWebSocket;
  log(`[ws] 已接管 WebSocket（经代理 ${String(proxyUrl).replace(/\/\/[^@/]*@/, '//***@')}）`);
  return ProxiedWebSocket;
}

/** healthz 用 */
export function proxyWsSnapshot() {
  return { ...wsStat, installed: !!installed };
}

export function restoreWebSocket() {
  if (!installed) return;
  delete globalThis.WebSocket;
  installed = null;
}
