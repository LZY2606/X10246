import { createHash } from 'node:crypto';
import type { ContentRef } from './types.js';

/**
 * Canonical JSON: object keys sorted recursively, UTF-8, no whitespace.
 * Deterministic across processes so content identities survive export/reimport.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJSON(item)).join(',') + ']';
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    '{' +
    keys
      .map((key) => JSON.stringify(key) + ':' + canonicalJSON(record[key]))
      .join(',') +
    '}'
  );
}

export function contentRef(value: unknown): ContentRef {
  const canonical = canonicalJSON(value);
  return {
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(canonical, 'utf8')
  };
}

export function shortDigest(value: unknown): string {
  return contentRef(value).sha256.slice(0, 12);
}

export function digestOfString(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
