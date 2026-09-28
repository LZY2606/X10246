import { createHash } from 'node:crypto';

/** 规范 JSON：键排序，无多余空白，保证不同进程/导出导入后哈希一致。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function shortHash(value: unknown, len = 12): string {
  return sha256(value).slice(0, len);
}

export function versionId(entityId: string, version: number): string {
  return `${entityId}#v${version}`;
}

/** 网格坐标转稳定键。 */
export function pxKey(col: number, row: number): string {
  return `${col}:${row}`;
}

export function edgeId(a: [number, number], b: [number, number]): string {
  const [[c1, r1], [c2, r2]] = [a, b];
  const key = (c1 - c2) * 10000 + (r1 - r2) * 100;
  if (key < 0) return `e:${c2}:${r2}:${c1}:${r1}`;
  return `e:${c1}:${r1}:${c2}:${r2}`;
}
