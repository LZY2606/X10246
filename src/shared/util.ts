import { createHash } from "node:crypto";
import type { Cell, ClockRng, Sha256 } from "./types.ts";

/** Deterministic JSON key ordering so hashes are reproducible across machines. */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): Sha256 {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashJson(value: unknown): Sha256 {
  return sha256Hex(canonicalJSON(value));
}

export function token(cell: Cell): string {
  return `${cell.r}:${cell.c}`;
}

export function parseToken(tok: string): Cell {
  const [r, c] = tok.split(":").map(Number);
  if (!Number.isInteger(r) || !Number.isInteger(c)) {
    throw new Error(`bad cell token: ${tok}`);
  }
  return { r, c };
}

export function idx(dims: { rows: number; cols: number }, r: number, c: number): number {
  return r * dims.cols + c;
}

export function inBounds(dims: { rows: number; cols: number }, r: number, c: number): boolean {
  return r >= 0 && c >= 0 && r < dims.rows && c < dims.cols;
}

export function neighbours4(dims: { rows: number; cols: number }, r: number, c: number): Cell[] {
  const out: Cell[] = [];
  if (r > 0) out.push({ r: r - 1, c });
  if (r + 1 < dims.rows) out.push({ r: r + 1, c });
  if (c > 0) out.push({ r, c: c - 1 });
  if (c + 1 < dims.cols) out.push({ r, c: c + 1 });
  return out;
}

/** Fixed-seed PRNG (mulberry32). Same seed -> same sequence on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Virtual clock + RNG used by the whole domain layer (tests inject fixed values). */
export function deterministicContext(seed = 20260923, epochMs = 1_780_000_000_000): ClockRng {
  let tick = 0;
  const rand = mulberry32(seed);
  return {
    now: () => epochMs + tick++,
    next: rand
  };
}

/** Short, human-recognisable but collision-resistant stable identity. */
export function stableId(prefix: string, hash: Sha256): string {
  return `${prefix}_${hash.slice(0, 16)}`;
}

export function fingerprint(algorithmVersion: string, params: Record<string, unknown>): Sha256 {
  return hashJson({ algorithmVersion, params });
}

/** Wrap to (-pi, pi]. */
export function wrapPi(x: number): number {
  let y = x % (2 * Math.PI);
  if (y <= -Math.PI) y += 2 * Math.PI;
  if (y > Math.PI) y -= 2 * Math.PI;
  return y;
}

/**
 * Principal wrapped difference in cycles, result in (-0.5, 0.5].
 * d = (b - a) in radians.
 */
export function wrappedDeltaCycles(a: number, b: number): number {
  let d = (b - a) / (2 * Math.PI);
  d = d - Math.round(d);
  if (d === -0.5) d = 0.5;
  return d;
}

export function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}
