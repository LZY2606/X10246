import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively so equal data => equal digest. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function shortHash(value: unknown, length = 12): string {
  return sha256(value).slice(0, length);
}
