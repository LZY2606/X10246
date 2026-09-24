import type { GridBasis } from './types.js';

export function idx(basis: GridBasis, r: number, c: number): number {
  return r * basis.cols + c;
}
export function inBounds(basis: GridBasis, r: number, c: number): boolean {
  return r >= 0 && c >= 0 && r < basis.rows && c < basis.cols;
}
/** 4 邻域（只含界内） */
export function neighbors4(basis: GridBasis, r: number, c: number): Array<{ r: number; c: number }> {
  return [
    { r: r - 1, c },
    { r: r + 1, c },
    { r, c: c - 1 },
    { r, c: c + 1 },
  ].filter((p) => inBounds(basis, p.r, p.c));
}
export function edgeKey(a: { r: number; c: number }, b: { r: number; c: number }): string {
  const k1 = a.r * 1_000_000 + a.c;
  const k2 = b.r * 1_000_000 + b.c;
  return k1 < k2 ? `${k1}|${k2}` : `${k2}|${k1}`;
}
