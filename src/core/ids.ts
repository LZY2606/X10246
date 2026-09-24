import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

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

export function contentBlobId(kind: string, canonical: string): string {
  return `blob_${kind}_${shortHash(kind + ' ' + canonical)}`;
}

export function deriveEventId(seq: number, type: string, payload: unknown): string {
  return `evt_${String(seq).padStart(5, '0')}_${shortHash(type + ' ' + canonicalJson(payload))}`;
}

export function versionId(kind: string, seq: number): string {
  return `ver_${kind}_${String(seq).padStart(4, '0')}`;
}

/** Deterministic, seedable PRNG (mulberry32) — tests and case packs use fixed seeds. */
export function seededRng(seed: string): () => number {
  let a = parseInt(sha256Hex(seed).slice(0, 8), 16) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pixelId(x: number, y: number): string {
  return `p${x}_${y}`;
}

export function edgeId(ax: number, ay: number, bx: number, by: number): string {
  const a = pixelId(ax, ay);
  const b = pixelId(bx, by);
  return a < b ? `${a}--${b}` : `${a}--${b}`;
}
