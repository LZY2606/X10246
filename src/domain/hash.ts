import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序，保证参数指纹稳定 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

/** 内容摘要（SHA-256 前 16 字节 hex），原始片段内容寻址 */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex').slice(0, 32);
}

/** 稳定实体 ID：种类 + 内容摘要。相同原始材料 => 同一 ID => 共享只存一份 */
export function contentEntityId(kind: string, value: unknown): string {
  return `${kind}:${digestOf(value)}`;
}

/** 版本 ID：实体 + 版本号 + 版本摘要 */
export function versionId(entityId: string, version: number): string {
  return `${entityId}#v${version}`;
}
