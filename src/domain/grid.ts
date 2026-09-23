/** Row-major scalar grid. null is represented by NaN in raw data and by null in derived layers. */
export interface Grid {
  width: number;
  height: number;
  data: number[];
}

export function makeGrid(width: number, height: number, fn: (x: number, y: number) => number): Grid {
  const data = new Array<number>(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = fn(x, y);
  }
  return { width, height, data };
}

export function at(g: Grid, x: number, y: number): number {
  return g.data[y * g.width + x];
}

export function gridShapeOk(g: Grid): boolean {
  return (
    Number.isInteger(g.width) &&
    Number.isInteger(g.height) &&
    g.width > 0 &&
    g.height > 0 &&
    Array.isArray(g.data) &&
    g.data.length === g.width * g.height
  );
}

export const TWO_PI = Math.PI * 2;

/** Wrap a phase value into (-pi, pi]. */
export function wrapToPi(v: number): number {
  let w = (v + Math.PI) % TWO_PI;
  if (w < 0) w += TWO_PI;
  const r = w - Math.PI;
  return r === -Math.PI ? Math.PI : r;
}
