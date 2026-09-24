import { createHash } from 'node:crypto';

export function sha256Hex(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** 稳定 JSON：键排序，保证跨进程/跨机器一致 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function shortDigest(value: unknown, len = 12): string {
  return digestOf(value).slice(0, len);
}

/** 内容身份：前缀 + 内容摘要。同样内容必得同样身份（导出/再导入稳定） */
export function contentId(prefix: string, content: unknown): string {
  return `${prefix}_${digestOf(content).slice(0, 24)}`;
}

/** 固定 seed 的确定性 PRNG（mulberry32）——测试与案例包可复现 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
