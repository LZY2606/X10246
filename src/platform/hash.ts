import { createHash } from 'node:crypto';

// 规范化 JSON：键排序，确保身份跨进程/跨导入稳定
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function stableHash(parts: unknown[]): string {
  return 'h' + createHash('sha256').update(parts.map(canonicalize).join('')).digest('hex').slice(0, 16);
}

export function artifactId(kind: string, lineage: string, version: number, parentId: string | null, content: unknown): string {
  return stableHash(['artifact', kind, lineage, version, parentId, content]);
}

export function eventId(type: string, seq: number, atVirtual: number, parentEventId: string | null, data: unknown): string {
  return stableHash(['event', type, seq, atVirtual, parentEventId, data]);
}
