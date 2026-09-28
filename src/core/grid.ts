/** 规则网格：所有相位/振幅/遮罩/高度图的公共载体。 */
export interface Grid {
  width: number;
  height: number;
  data: number[]; // 行主序，长度 = width*height
}

export function makeGrid(width: number, height: number, fill = 0): Grid {
  return { width, height, data: new Array(width * height).fill(fill) };
}

export function idx(g: Grid, row: number, col: number): number {
  return row * g.width + col;
}

export function inBounds(g: Grid, row: number, col: number): boolean {
  return row >= 0 && row < g.height && col >= 0 && col < g.width;
}

export function neighbors4(g: Grid, row: number, col: number): Array<{ row: number; col: number }> {
  const out: Array<{ row: number; col: number }> = [];
  if (row > 0) out.push({ row: row - 1, col });
  if (row < g.height - 1) out.push({ row: row + 1, col });
  if (col > 0) out.push({ row, col: col - 1 });
  if (col < g.width - 1) out.push({ row, col: col + 1 });
  return out;
}

/** 包裹算子：把任意弧度差折回 (-π, π]。 */
export function wrapPhase(x: number): number {
  let v = x % (2 * Math.PI);
  if (v <= -Math.PI) v += 2 * Math.PI;
  if (v > Math.PI) v -= 2 * Math.PI;
  return v;
}

export function gridSummary(g: Grid): { width: number; height: number; min: number; max: number } {
  let min = Infinity, max = -Infinity;
  for (const v of g.data) { if (v < min) min = v; if (v > max) max = v; }
  return { width: g.width, height: g.height, min, max };
}
