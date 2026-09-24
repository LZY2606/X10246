import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），用于参数指纹与内容摘要 */
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

/** SHA-256 摘要，返回 hex（默认 16 位前缀） */
export function sha256(value: unknown, prefix = 16): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, prefix);
}

/** 稳定身份：类别 + 摘要，保证导出/删除/导入后身份不变 */
export function stableId(kind: string, value: unknown): string {
  return `${kind}_${sha256(value, 20)}`;
}
