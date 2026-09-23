import type { Grid, CoordinateBasis, MaskCell } from './types';

export const TWO_PI = Math.PI * 2;

export function basis(rows: number, cols: number, pixelPitchNm = 1): CoordinateBasis {
  return { type: 'pixel_ij', rows, cols, origin: 'top-left', order: 'row-major', pixelPitch: { value: pixelPitchNm, unit: 'nm' } };
}

export function grid(values: number[], unit: string, b: CoordinateBasis, encoding: Grid['encoding'] = 'float64'): Grid {
  if (values.length !== b.rows * b.cols) throw new Error(`GRID_SHAPE_MISMATCH: ${values.length} != ${b.rows * b.cols}`);
  return { values: values.slice(), unit, coordinateBasis: b, encoding };
}

export const idx = (b: CoordinateBasis, r: number, c: number) => r * b.cols + c;
export const rowOf = (b: CoordinateBasis, p: number) => Math.floor(p / b.cols);
export const colOf = (b: CoordinateBasis, p: number) => p % b.cols;

/** 包裹到主值 (-π, π] */
export function wrap(phi: number): number {
  let w = phi % TWO_PI;
  if (w <= -Math.PI) w += TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  return w;
}

/** 主值差分 Δ = wrap(b - a) */
export function wrappedDiff(a: number, b: number): number {
  return wrap(b - a);
}

/** 无向边规范键，u<v */
export function canonicalEdgeKey(u: number, v: number): string {
  return u < v ? `${u}-${v}` : `${v}-${u}`;
}

export function neighbors4(p: number, b: CoordinateBasis): number[] {
  const r = rowOf(b, p), c = colOf(b, p), out: number[] = [];
  if (r > 0) out.push(p - b.cols);
  if (r < b.rows - 1) out.push(p + b.cols);
  if (c > 0) out.push(p - 1);
  if (c < b.cols - 1) out.push(p + 1);
  return out;
}

/** 遮罩值编解码（Grid encoding='mask'）：0 valid / 1 invalid / 2 low_amplitude_hole */
const MASK_CODES: Record<MaskCell, number> = { valid: 0, invalid: 1, low_amplitude_hole: 2 };
const MASK_FROM: MaskCell[] = ['valid', 'invalid', 'low_amplitude_hole'];
export function encodeMask(cells: MaskCell[]): number[] { return cells.map((c) => MASK_CODES[c]); }
export function decodeMask(g: Grid): MaskCell[] {
  return g.values.map((v) => MASK_FROM[v] ?? 'invalid');
}

/** 固定 seed 的可复现 PRNG（mulberry32）—— 仅用于样例生成 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
