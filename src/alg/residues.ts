import { TWO_PI, nearestInteger, wrapPi } from '../domain/units';
import type { Grid2D } from '../domain/types';

export function idx(grid: Grid2D, x: number, y: number): number {
  return y * grid.width + x;
}

export function neighbors(i: number, grid: Grid2D): { n: number; x: number; y: number }[] {
  const x = i % grid.width;
  const y = Math.floor(i / grid.width);
  const out: { n: number; x: number; y: number }[] = [];
  if (x > 0) out.push({ n: i - 1, x: x - 1, y });
  if (x + 1 < grid.width) out.push({ n: i + 1, x: x + 1, y });
  if (y > 0) out.push({ n: i - grid.width, x, y: y - 1 });
  if (y + 1 < grid.height) out.push({ n: i + grid.width, x, y: y + 1 });
  return out;
}

/**
 * 2x2 plaquette 支路电荷：沿四个包裹相位差求和并四舍五入到整周。
 * 单位：整周。+1 / -1 为残差点，0 为闭合。
 */
export function plaquetteCharge(
  grid: Grid2D,
  phase: (number | null)[],
  px: number,
  py: number
): number | null {
  const w = grid.width;
  const p00 = phase[py * w + px];
  const p10 = phase[py * w + px + 1];
  const p11 = phase[(py + 1) * w + px + 1];
  const p01 = phase[(py + 1) * w + px];
  if ([p00, p10, p11, p01].some((p) => p === null)) return null;
  const sum =
    wrapDiff(p10 as number, p00 as number) +
    wrapDiff(p11 as number, p10 as number) +
    wrapDiff(p01 as number, p11 as number) +
    wrapDiff(p00 as number, p01 as number);
  return nearestInteger(sum / TWO_PI);
}

export function wrapDiff(a: number, b: number): number {
  return wrapPi(a - b);
}

export function detectResidues(grid: Grid2D, phase: (number | null)[]): {
  charge: number[];
  positive: [number, number][];
  negative: [number, number][];
} {
  const charge: number[] = new Array((grid.width - 1) * (grid.height - 1)).fill(0);
  const positive: [number, number][] = [];
  const negative: [number, number][] = [];
  for (let py = 0; py < grid.height - 1; py++) {
    for (let px = 0; px < grid.width - 1; px++) {
      const q = plaquetteCharge(grid, phase, px, py);
      const ci = py * (grid.width - 1) + px;
      if (q === null) {
        charge[ci] = 0;
        continue;
      }
      charge[ci] = q;
      if (q > 0) positive.push([px, py]);
      if (q < 0) negative.push([px, py]);
    }
  }
  return { charge, positive, negative };
}

/** 检测跨越 ±pi 边界的边（包装跳变）——“相位跨越边界”情形的一等诊断 */
export function wrapBoundaryEdges(
  grid: Grid2D,
  phase: (number | null)[]
): { a: number; b: number; jump: number }[] {
  const out: { a: number; b: number; jump: number }[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      const p = phase[i];
      if (p === null) continue;
      if (x + 1 < grid.width) {
        const q = phase[i + 1];
        if (q !== null && Math.abs(wrapDiff(q, p)) > Math.PI / 2) {
          out.push({ a: i, b: i + 1, jump: wrapDiff(q, p) });
        }
      }
      if (y + 1 < grid.height) {
        const q = phase[i + grid.width];
        if (q !== null && Math.abs(wrapDiff(q, p)) > Math.PI / 2) {
          out.push({ a: i, b: i + grid.width, jump: wrapDiff(q, p) });
        }
      }
    }
  }
  return out;
}
