import { createHash } from 'node:crypto';

/** 稳定 JSON：键排序，NaN/Infinity 序列化为字符串哨兵 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}
function sortValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return `__nonfinite:${String(v)}`;
    return v;
  }
  if (Array.isArray(v)) return v.map(sortValue);
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) out[k] = sortValue(obj[k]);
  return out;
}
export function contentHashOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}
