import type { Grid } from '../shared/domain';
import { idx } from './grid';

/** 包裹到 [-π, π) */
export function wrapAngle(a: number): number {
  let r = a % (2 * Math.PI);
  if (r < -Math.PI) r += 2 * Math.PI;
  if (r >= Math.PI) r -= 2 * Math.PI;
  return r;
}

/** 包裹差分：两个相邻像素的相位差的包裹值 */
export function wrappedDifference(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** 2x2 环残差：四个包裹差分之和，0/±2π */
export function cycleResidual(g: Grid, x: number, y: number, valid: (x: number, y: number) => boolean): number | null {
  if (!valid(x, y) || !valid(x + 1, y) || !valid(x + 1, y + 1) || !valid(x, y + 1)) return null;
  const a = wrappedDifference(g.values[idx(g, x, y)]!, g.values[idx(g, x + 1, y)]!);
  const b = wrappedDifference(g.values[idx(g, x + 1, y)]!, g.values[idx(g, x + 1, y + 1)]!);
  const c = wrappedDifference(g.values[idx(g, x + 1, y + 1)]!, g.values[idx(g, x, y + 1)]!);
  const d = wrappedDifference(g.values[idx(g, x, y + 1)]!, g.values[idx(g, x, y)]!);
  return a + b + c + d;
}
