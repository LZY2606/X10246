import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），保证同内容同摘要，与字段顺序无关。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortValue((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** 内容摘要：只对「内容」哈希，头里的 status/createdAt 不参与，避免状态污染不可变内容。 */
export function contentHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** 稳定身份：领域前缀 + 内容短哈希。相同原始片段在最小/组合输入中只存一份不可变内容。 */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 16)}`;
}

/** 参数指纹：算法版本 + 规范化参数。 */
export function parameterFingerprint(algorithmVersion: string, params: unknown): string {
  return `${algorithmVersion}:${createHash('sha256')
    .update(canonicalize(params))
    .digest('hex')
    .slice(0, 12)}`;
}
