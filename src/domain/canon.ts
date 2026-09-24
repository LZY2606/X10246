import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序，保证同一内容得到同一指纹。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

/** 稳定身份：由前缀 + 内容指纹派生，导出/导入后保持不变。 */
export function stableId(prefix: string, payload: unknown): string {
  return `${prefix}_${sha256(canonical(payload)).slice(0, 16)}`;
}

/** 固定 seed 的确定性 PRNG（mulberry32），测试与场景生成共用。 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
