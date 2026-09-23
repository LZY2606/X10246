import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256(stableStringify(value));
}

export function fingerprint(value: unknown): string {
  return contentHash(value).slice(0, 16);
}

/** 固定 seed 的确定性随机源（mulberry32），测试与演示共用 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 可注入时钟：服务器用真实时钟，测试用虚拟时钟 */
export interface Clock { now(): string }
export const systemClock: Clock = { now: () => new Date().toISOString() };
export function virtualClock(startIso = '2026-09-19T00:00:00.000Z'): Clock & { tick(ms: number): void } {
  let t = new Date(startIso).getTime();
  return {
    now: () => new Date(t).toISOString(),
    tick: (ms: number) => { t += ms; }
  };
}

let idCounter = 0;
export function resetIdCounter(): void { idCounter = 0; }
export function nextId(prefix: string, rand: () => number): string {
  idCounter += 1;
  const randPart = Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0');
  return `${prefix}_${idCounter.toString(36)}${randPart}`;
}
