import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  // 键排序、无多余空白的规范化 JSON，保证跨平台/跨进程一致
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function shortHash(hash: string): string {
  return hash.slice(0, 18);
}
