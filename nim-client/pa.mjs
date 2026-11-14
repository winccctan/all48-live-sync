import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import init, { __x6c2adf8__ as x6c2adf8 } from './rust-wasm.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const wasmBytes = await readFile(new URL('./pa.wasm', import.meta.url));
await init(wasmBytes);

// 生成口袋48请求所需的 pa 签名头
export function generatePa() {
  return x6c2adf8();
}
