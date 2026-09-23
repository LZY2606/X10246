import type { RawGrid, NumberToken, PixelRef, EdgeRef } from "../shared/types.js";

export const TWO_PI = Math.PI * 2;

export function wrap(a: number): number {
  let x = a % TWO_PI;
  if (x > Math.PI) x -= TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  return x;
}

export function idx(x: number, y: number, width: number): number {
  return y * width + x;
}
export function xy(index: number, width: number): PixelRef {
  return { x: index % width, y: Math.floor(index / width) };
}

export function num(vals: NumberToken[]): (number | null)[] {
  return vals.map((t) => t.value);
}

export function inBounds(p: PixelRef, w: number, h: number): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < w && p.y < h;
}

export function edgeKey(e: EdgeRef): string {
  // 规范化方向，保证 a-b / b-a 同一边
  const ka = `${e.a.x},${e.a.y}`;
  const kb = `${e.b.x},${e.b.y}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

export function neighbors4(p: PixelRef, w: number, h: number): PixelRef[] {
  return [
    { x: p.x + 1, y: p.y },
    { x: p.x, y: p.y + 1 },
    { x: p.x - 1, y: p.y },
    { x: p.x, y: p.y - 1 },
  ].filter((q) => inBounds(q, w, h));
}

export function gridValues(g: RawGrid): (number | null)[] {
  return g.cells.map((c) => c.value);
}

// 把可能为 null 的栅格安全取出数值。
export function requireValues(
  g: RawGrid,
): { values: number[]; badIndices: number[] } {
  const values: number[] = [];
  const badIndices: number[] = [];
  g.cells.forEach((c, i) => {
    if (c.value === null || Number.isNaN(c.value)) badIndices.push(i);
    values.push(c.value ?? NaN);
  });
  return { values, badIndices };
}
