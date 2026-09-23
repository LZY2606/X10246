import { createHash } from 'node:crypto';

/** 稳定内容摘要：用于不可变内容寻址与参数指纹。 */
export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function shortHash(value: unknown): string {
  return contentHash(value).slice(0, 12);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
