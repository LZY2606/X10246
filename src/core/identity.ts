/**
 * 稳定身份、内容指纹与固定 seed 随机源。
 * - stableId 永久标识一个显示值/实体，跨导出-删除-导入保持不变。
 * - contentHash 对不可变原始片段做内容寻址（共享片段只存一份）。
 * - 不依赖 Math.random / Date.now：测试用固定 seed 与虚拟时间。
 */
import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），保证等价内容哈希一致 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 内容哈希（Node 环境，sha256） */
export function contentHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 纯字符串哈希，用于片段去重键（与环境无关的轻量实现） */
export function stableStringHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const h = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return 'h' + h.toString(16).padStart(13, '0');
}

/** 固定 seed 的可复现 PRNG（mulberry32） */
export class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** 形如 ev_0001AB2 的稳定短 id */
  id(prefix: string): string {
    const n = Math.floor(this.next() * 0x7fffffff);
    return `${prefix}_${n.toString(16).toUpperCase().padStart(8, '0')}`;
  }
}

/** 虚拟时钟：测试中手动推进，绝不读系统时钟 */
export class VirtualClock {
  private nowMs: number;
  constructor(startMs = 1_700_000_000_000) {
    this.nowMs = startMs;
  }
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): number {
    this.nowMs += ms;
    return this.nowMs;
  }
}
