// 网格几何与包裹差（相位展开基本操作）

export const TWO_PI = Math.PI * 2;

export function idx(u: number, v: number, width: number): number {
  return v * width + u;
}
export function inBounds(u: number, v: number, width: number, height: number): boolean {
  return u >= 0 && v >= 0 && u < width && v < height;
}

/** 包到 [-pi, pi) */
export function wrapToPi(phi: number): number {
  let r = ((phi + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  if (r === -Math.PI) r = Math.PI; // 归到 [.. , pi)
  return r;
}

/**
 * 有向包裹差：wrap(phiB - phiA)，并标记是否跨越 +/-pi 包裹边界。
 */
export function wrappedDelta(phiA: number, phiB: number): { delta: number; crosses: boolean } {
  const d = phiB - phiA;
  const w = wrapToPi(d);
  const crosses = Math.abs(d) > Math.PI - 1e-9 && Math.sign(w) !== Math.sign(d);
  return { delta: w, crosses };
}

export interface Edge {
  a: [number, number];
  b: [number, number];
}

export function edgeId(a: [number, number], b: [number, number]): string {
  const key = (p: [number, number]) => `${p[0]},${p[1]}`;
  return [key(a), key(b)].sort().join('|');
}

/** 4 邻接 */
export const NEIGHBORS: [number, number][] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1]
];

export function manhattan(a: [number, number], b: [number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}
