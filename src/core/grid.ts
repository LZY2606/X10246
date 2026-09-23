import type { GridPayload } from './types.js';

export interface Grid {
  rows: number;
  cols: number;
  values: Float64Array;
  invalid: Uint8Array;
}

export function toGrid(payload: GridPayload): Grid {
  const { rows, cols } = payload.grid;
  const values = new Float64Array(rows * cols);
  const invalid = new Uint8Array(rows * cols);
  for (let i = 0; i < values.length; i += 1) values[i] = payload.values[i]!;
  for (const index of payload.nodata) invalid[index] = 1;
  return { rows, cols, values, invalid };
}

export function idx(rows: number, cols: number, r: number, c: number): number {
  return r * cols + c;
}

export function inBounds(rows: number, cols: number, r: number, c: number): boolean {
  return r >= 0 && r < rows && c >= 0 && c < cols;
}

export function edgeId(r1: number, c1: number, r2: number, c2: number): string {
  return `${r1},${c1}-${r2},${c2}`;
}

/** Wrapped phase difference in (-pi, pi] for two neighbor samples. */
export function wrappedDiff(a: number, b: number): number {
  let d = a - b;
  d = ((d + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Whole-cycle (2*pi) count crossed by the wrapped difference a-b. */
export function cyclesCrossed(a: number, b: number): number {
  const raw = a - b;
  return Math.round((raw - wrappedDiff(a, b)) / (2 * Math.PI));
}
