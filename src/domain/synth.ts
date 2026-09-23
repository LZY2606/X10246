import type { Grid, MaskGrid } from '../shared/types.ts';
import { makeGrid, makeMask, wrapToPi } from './grid.ts';

/** 固定 seed 的确定性伪随机数（mulberry32），仅用于样例数据合成 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 倾斜平面包裹相位 */
export function tiltPhase(rows: number, cols: number, slopeR: number, slopeC: number): Grid {
  const g = makeGrid(rows, cols, 0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      g[r]![c] = wrapToPi(slopeR * r + slopeC * c);
    }
  }
  return g;
}

/** 含残差的包裹相位：在指定 plaquette 注入 2π 位错 */
export function phaseWithDislocation(
  rows: number,
  cols: number,
  at: [number, number],
  slopeC = 0.4,
): Grid {
  const g = tiltPhase(rows, cols, 0.1, slopeC);
  // 在 at 右下方加一个 2π 阶跃的半平面，形成残差对
  for (let r = at[0] + 1; r < rows; r++) {
    for (let c = at[1] + 1; c < cols; c++) {
      g[r]![c] = wrapToPi(g[r]![c]! + Math.PI * 1.2);
    }
  }
  return g;
}

export function uniformAmplitude(rows: number, cols: number, value = 1): Grid {
  return makeGrid(rows, cols, value);
}

export function amplitudeWithHole(
  rows: number,
  cols: number,
  hole: { r0: number; c0: number; r1: number; c1: number },
): Grid {
  const g = uniformAmplitude(rows, cols, 1);
  for (let r = hole.r0; r <= hole.r1; r++) {
    for (let c = hole.c0; c <= hole.c1; c++) {
      g[r]![c] = 0.001;
    }
  }
  return g;
}

export function fullMask(rows: number, cols: number): MaskGrid {
  return makeMask(rows, cols, true);
}

/** 中间一条无效带，把有效区分成两个不连通岛 */
export function twoIslandMask(rows: number, cols: number, bandCol: number): MaskGrid {
  const m = fullMask(rows, cols);
  for (let r = 0; r < rows; r++) m[r]![bandCol] = false;
  return m;
}
