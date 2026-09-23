import type { Grid, MaskGrid, Pixel } from '../shared/types.ts';

export const TWO_PI = Math.PI * 2;

/** 包裹到 (-π, π] */
export function wrapToPi(x: number): number {
  let y = x % TWO_PI;
  if (y <= -Math.PI) y += TWO_PI;
  else if (y > Math.PI) y -= TWO_PI;
  return y;
}

/** 包裹梯度：从 a 到 b 的最短相位步进 */
export function wrappedDiff(a: number, b: number): number {
  return wrapToPi(b - a);
}

export function shape(g: Grid | MaskGrid): { rows: number; cols: number } {
  return { rows: g.length, cols: g[0]?.length ?? 0 };
}

export function makeGrid(rows: number, cols: number, fill: number): Grid {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
}

export function makeMask(rows: number, cols: number, fill: boolean): MaskGrid {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill));
}

export function pixelKey(p: Pixel): string {
  return `${p[0]},${p[1]}`;
}

export function edgeKey(a: Pixel, b: Pixel): string {
  const ka = pixelKey(a);
  const kb = pixelKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function neighbors(p: Pixel, rows: number, cols: number): Pixel[] {
  const [r, c] = p;
  const out: Pixel[] = [];
  if (r > 0) out.push([r - 1, c]);
  if (r + 1 < rows) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c + 1 < cols) out.push([r, c + 1]);
  return out;
}
