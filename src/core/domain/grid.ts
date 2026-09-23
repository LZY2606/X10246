import type { GridData } from "../../shared/types.js";

export function at(grid: { width: number; height: number; values: (number | null | boolean)[] }, x: number, y: number) {
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return undefined;
  return grid.values[y * grid.width + x];
}

export function idx(width: number, x: number, y: number) {
  return y * width + x;
}

export function neighbors4(x: number, y: number, w: number, h: number) {
  const out: { x: number; y: number }[] = [];
  if (x > 0) out.push({ x: x - 1, y });
  if (x < w - 1) out.push({ x: x + 1, y });
  if (y > 0) out.push({ x, y: y - 1 });
  if (y < h - 1) out.push({ x, y: y + 1 });
  return out;
}

export function wrappedDiff(a: number, b: number, wrapRange: "[-pi,pi)" | "[0,2pi)"): number {
  // a -> b 的包裹相位差（-pi..pi]
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  void wrapRange;
  return d;
}

export function gridData(w: number, h: number, values: (number | null)[]): GridData {
  return { width: w, height: h, values };
}
