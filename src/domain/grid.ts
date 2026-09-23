import type { Grid } from "../shared/types.js";

export function idx(g: { width: number }, r: number, c: number): number {
  return r * g.width + c;
}

export function inBounds(g: { width: number; height: number }, r: number, c: number): boolean {
  return r >= 0 && c >= 0 && r < g.height && c < g.width;
}

export function neighbors4(g: { width: number; height: number }, r: number, c: number): [number, number][] {
  const out: [number, number][] = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < g.height - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < g.width - 1) out.push([r, c + 1]);
  return out;
}

/** 边的规范键：两端像素坐标排序后拼接 */
export function edgeKey(a: [number, number], b: [number, number]): string {
  const s = `${a[0]},${a[1]}`;
  const t = `${b[0]},${b[1]}`;
  return s < t ? `${s}|${t}` : `${t}|${s}`;
}

export function parseEdgeKey(key: string): [[number, number], [number, number]] {
  const [s, t] = key.split("|") as [string, string];
  const [r1, c1] = s.split(",").map(Number) as [number, number];
  const [r2, c2] = t.split(",").map(Number) as [number, number];
  return [[r1, c1], [r2, c2]];
}

export function makeGrid(width: number, height: number, fill: (r: number, c: number) => number): Grid {
  const data: number[] = new Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[r * width + c] = fill(r, c);
  return { width, height, data };
}
