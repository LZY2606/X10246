/** 二维网格基础工具（行主序） */

export function idx(rows: number, cols: number, r: number, c: number): number {
  return r * cols + c;
}
export function rcOf(cols: number, index: number): [number, number] {
  return [Math.floor(index / cols), index % cols];
}

export function neighbors4(index: number, rows: number, cols: number): number[] {
  const r = Math.floor(index / cols);
  const c = index % cols;
  const out: number[] = [];
  if (r > 0) out.push(index - cols);
  if (r + 1 < rows) out.push(index + cols);
  if (c > 0) out.push(index - 1);
  if (c + 1 < cols) out.push(index + 1);
  return out;
}

export function edgeId(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** 包裹到 [-π, π) */
export function wrapRad(x: number): number {
  let y = x % (2 * Math.PI);
  if (y >= Math.PI) y -= 2 * Math.PI;
  if (y < -Math.PI) y += 2 * Math.PI;
  return y;
}

/** 两个有效像素之间的包裹相位差 w(j - i)，落在 [-π,π) */
export function wrappedDelta(phase: (number | null)[], i: number, j: number): number | null {
  const a = phase[i];
  const b = phase[j];
  if (a === null || b === null || Number.isNaN(a) || Number.isNaN(b)) return null;
  return wrapRad(b - a);
}
