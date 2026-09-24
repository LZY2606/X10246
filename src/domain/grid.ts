/** 规则采样网格，领域数据（相位、质量、遮罩、高度）的公共载体。 */
export interface Grid {
  width: number;
  height: number;
  /** 行优先，长度 = width*height；null 表示该像素未知/无效。 */
  data: (number | null)[];
}

export function makeGrid(width: number, height: number, fill: (x: number, y: number) => number | null): Grid {
  const data: (number | null)[] = new Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = fill(x, y);
  return { width, height, data };
}

export function at(g: Grid, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x >= g.width || y >= g.height) return null;
  return g.data[y * g.width + x];
}

export function idx(g: Grid, x: number, y: number): number {
  return y * g.width + x;
}

export const TWO_PI = Math.PI * 2;

/** 包裹到 (-π, π]。 */
export function wrapPhase(v: number): number {
  let r = v % TWO_PI;
  if (r <= -Math.PI) r += TWO_PI;
  else if (r > Math.PI) r -= TWO_PI;
  return r;
}
