import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），保证同一内容得到同一摘要 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function digestOf(content: unknown): string {
  return sha256(canonicalize(content));
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
