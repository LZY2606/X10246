import { createHash } from 'node:crypto';

/** 确定性 JSON 序列化：键排序、无 undefined，用于内容寻址与参数指纹。 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内容寻址：同一内容永远得到同一 contentId。 */
export function contentIdOf(value: unknown): string {
  return 'sha256:' + sha256Hex(canonicalStringify(value));
}

export function shortHash(value: unknown, len = 16): string {
  return sha256Hex(canonicalStringify(value)).slice(0, len);
}
