/** 二维网格基础类型。所有领域量都以行主序 number[] 存储。 */
export interface Grid {
  width: number;
  height: number;
  data: number[];
}

export function makeGrid(width: number, height: number, fill = 0): Grid {
  return { width, height, data: new Array<number>(width * height).fill(fill) };
}

export function idx(g: { width: number }, x: number, y: number): number {
  return y * g.width + x;
}

export function inBounds(g: { width: number; height: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.width && y < g.height;
}

/** 网格区域，用于局部依赖与局部锁定。 */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function regionsOverlap(a: Region, b: Region): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function fullRegion(g: { width: number; height: number }): Region {
  return { x: 0, y: 0, width: g.width, height: g.height };
}

/** 包裹相位差，结果落在 (-π, π]。 */
export function wrapPhase(v: number): number {
  const twoPi = Math.PI * 2;
  let d = ((v + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  if (d <= -Math.PI) d += twoPi;
  return d;
}

export function wrapDiff(a: number, b: number): number {
  return wrapPhase(b - a);
}
