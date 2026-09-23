import { createHash } from 'node:crypto';

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(',')}}`;
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value).slice(0, 16)}`;
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __INTERFEROMETRIC_NOW__: number | undefined;
}

export function currentTime(): number {
  return globalThis.__INTERFEROMETRIC_NOW__ ?? Date.now();
}

export function fingerprintObject(value: unknown): string {
  return stableHash(value).slice(0, 12);
}
