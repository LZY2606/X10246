import { createHash } from 'node:crypto';

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 内容摘要：任何实体/版本的稳定指纹。 */
export function digestOf(value: unknown): string {
  return sha256(canonicalize(value));
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}
