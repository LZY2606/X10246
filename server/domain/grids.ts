import type { Grid2D, MaskGrid } from '../../shared/types';

export const TWO_PI = Math.PI * 2;

/** 包裹到 (-pi, pi]。 */
export function wrapPhase(x: number): number {
  let v = x % TWO_PI;
  if (v <= -Math.PI) v += TWO_PI;
  else if (v > Math.PI) v -= TWO_PI;
  return v;
}

export function idx(g: { width: number }, x: number, y: number): number {
  return y * g.width + x;
}

export function makeGrid(width: number, height: number, fill: (x: number, y: number) => number, unit: Grid2D['unit'], datum: Grid2D['datum']): Grid2D {
  const values = new Array<number>(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = fill(x, y);
  return { width, height, values, unit, datum };
}

export function emptyMask(width: number, height: number): MaskGrid {
  return { width, height, invalid: new Array<boolean>(width * height).fill(false), datum: 'pixel-grid' };
}

/** 四邻域，顺序可由 treeOrder 决定（不同展开树）。 */
export function neighbors(order: string): Array<[number, number]> {
  switch (order) {
    case 'row-major': return [[1, 0], [0, 1], [-1, 0], [0, -1]];
    case 'column-major': return [[0, 1], [1, 0], [0, -1], [-1, 0]];
    case 'diagonal-first': return [[1, 0], [0, -1], [0, 1], [-1, 0]];
    default: return [[1, 0], [0, 1], [-1, 0], [0, -1]];
  }
}
