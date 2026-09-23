export function makeGrid<T>(rows: number, cols: number, fill: (r: number, c: number) => T): T[][] {
  const g: T[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: T[] = [];
    for (let c = 0; c < cols; c++) row.push(fill(r, c));
    g.push(row);
  }
  return g;
}

export function dims(grid: unknown[][]): { rows: number; cols: number } {
  return { rows: grid.length, cols: grid.length ? grid[0].length : 0 };
}

export function neighbors4(r: number, c: number, rows: number, cols: number): [number, number][] {
  const out: [number, number][] = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < rows - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < cols - 1) out.push([r, c + 1]);
  return out;
}

export function wrapAngle(x: number): number {
  let y = x % (2 * Math.PI);
  if (y > Math.PI) y -= 2 * Math.PI;
  if (y <= -Math.PI) y += 2 * Math.PI; // (-π, π]
  return y;
}

export function key(r: number, c: number): string {
  return `${r},${c}`;
}
