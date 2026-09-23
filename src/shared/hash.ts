import { createHash } from 'node:crypto';

/** 规范化序列化：键排序，保证同一内容得到同一哈希 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
      .join(',') +
    '}'
  );
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
