import type { GridDatum, Pixel } from '../domain/types';

export function makeGrid(width: number, height: number): GridDatum {
  const metre = (v: number, unit = 'm') => ({ raw: String(v), value: v, unit });
  return {
    width,
    height,
    origin: { x: metre(0), y: metre(0) },
    pixelPitch: { x: metre(1), y: metre(1) },
  };
}

export const idx = (g: GridDatum, x: number, y: number): Pixel => y * g.width + x;
export const xy = (g: GridDatum, p: Pixel) => ({
  x: p % g.width,
  y: Math.floor(p / g.width),
});

export function inBounds(g: GridDatum, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.width && y < g.height;
}

export function neighbors4(g: GridDatum, p: Pixel): Pixel[] {
  const { x, y } = xy(g, p);
  const out: Pixel[] = [];
  if (x > 0) out.push(idx(g, x - 1, y));
  if (x + 1 < g.width) out.push(idx(g, x + 1, y));
  if (y > 0) out.push(idx(g, x, y - 1));
  if (y + 1 < g.height) out.push(idx(g, x, y + 1));
  return out;
}

export function edgeKey(a: Pixel, b: Pixel): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function wrappedDiff(a: number, b: number): number {
  // a 指向 b 的包裹差，结果落在 [-pi, pi)
  let d = b - a;
  while (d >= Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** 由包裹差推断整周增量：展开边 u->v 的 k_v - k_u。 */
export function integerStep(rawDiff: number): number {
  return Math.round(-rawDiff / (2 * Math.PI));
}
