/**
 * 稳定身份与规范化哈希。
 * 所有身份都由内容决定（content-addressed），因此导出 -> 删除本地数据库 -> 重新导入后，
 * 身份、顺序与来源关系保持不变。纯 TS 实现，浏览器与 Node 均可运行（不依赖 node:crypto）。
 */

const KIND_TAG = '__kind__' as const;

/** 53 位非加密哈希（cyrb53），输出 base36，确定性、跨环境一致。 */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(36).padStart(11, '0');
}

/** FNV-1a 64 位字节哈希（BigInt 实现），输出 base36。 */
export function hashBytes(bytes: Uint8Array): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x00000100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i] ?? 0);
    h = (h * prime) & mask;
  }
  return h.toString(36);
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_CHARS.indexOf(clean[i] ?? '');
    const c1 = BASE64_CHARS.indexOf(clean[i + 1] ?? '');
    const c2 = BASE64_CHARS.indexOf(clean[i + 2] ?? '');
    const c3 = BASE64_CHARS.indexOf(clean[i + 3] ?? '');
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  let pad = 0;
  if (b64.endsWith('==')) pad = 2;
  else if (b64.endsWith('=')) pad = 1;
  return Uint8Array.from(out.slice(0, out.length - pad));
}

/** Float64 小端字节，保证导入层原始数据逐位保留。 */
export function f64ArrayToBytes(arr: Float64Array): Uint8Array {
  const out = new Uint8Array(arr.length * 8);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < arr.length; i++) dv.setFloat64(i * 8, arr[i] ?? 0, true);
  return out;
}

export function bytesToF64Array(bytes: Uint8Array): Float64Array {
  const arr = new Float64Array(Math.floor(bytes.length / 8));
  const dv = new DataView(bytes.buffer, bytes.byteOffset, arr.length * 8);
  for (let i = 0; i < arr.length; i++) arr[i] = dv.getFloat64(i * 8, true);
  return arr;
}

/** 规范化 JSON：键排序、二进制/浮点数组带类型标签，NaN 等显式标记。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [KIND_TAG]: 'u8', b64: bytesToBase64(value) };
  if (value instanceof Float64Array) return { [KIND_TAG]: 'f64', b64: bytesToBase64(f64ArrayToBytes(value)) };
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = canonicalize((value as Record<string, unknown>)[k]);
    return out;
  }
  if (typeof value === 'number' && Number.isNaN(value)) return { [KIND_TAG]: 'nan' };
  return value;
}

export function contentHash(value: unknown): string {
  return hashString(canonicalJson(value));
}

export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${contentHash(value)}`;
}

export function rawContentId(bytes: Uint8Array): string {
  return `raw_${hashBytes(bytes)}`;
}
