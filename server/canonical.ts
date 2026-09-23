import { createHash } from 'node:crypto';

/** 确定性 JSON（键排序），用于内容寻址 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  // 浮点数规范化，避免 0.1+0.2 类抖动影响哈希
  if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) {
    return Number(v.toPrecision(15));
  }
  return v;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function shortId(hash: string): string {
  return hash.slice(0, 12);
}
