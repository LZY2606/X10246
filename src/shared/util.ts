import { createHash } from 'node:crypto';

/** 确定性 JSON（键排序），用于参数指纹与内容寻址 */
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortDeep(v));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    if (ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<number>);
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortDeep(o[k])]));
  }
  return v;
}

export function contentHash(content: unknown): string {
  return createHash('sha256').update(stableStringify(content)).digest('hex');
}

export function paramFingerprint(params: unknown): string {
  return contentHash(params).slice(0, 16);
}

/** 固定 seed 的确定性 RNG（mulberry32），测试与案例包共用 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 虚拟时钟：测试注入固定时间，运行时用真实时钟 */
export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
export function fixedClock(startIso = '2026-01-01T00:00:00.000Z'): Clock & { tick(): void } {
  let t = Date.parse(startIso);
  const c = (() => new Date(t)) as Clock & { tick(): void };
  c.tick = () => { t += 1000; };
  return c;
}

/** 确定性 id 生成：前缀 + 序号（每个项目内单调） */
export function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}_${(++n).toString().padStart(4, '0')}`;
}

export function bboxIntersect(a: { x0: number; y0: number; x1: number; y1: number } | null,
                                b: { x0: number; y0: number; x1: number; y1: number } | null): boolean {
  if (!a || !b) return true; // null = 全幅，恒相交
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}
