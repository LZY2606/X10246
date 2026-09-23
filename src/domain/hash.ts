import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），用于内容指纹与不可变片段去重 */
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

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function shortId(prefix: string, hash: string): string {
  return `${prefix}_${hash.slice(0, 12)}`;
}
