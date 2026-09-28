import type { GridData } from "../domain/types.ts";

export const TWO_PI = Math.PI * 2;

/** 包裹到 (-pi, pi] */
export function wrapPhase(x: number): number {
  let v = x % TWO_PI;
  if (v <= -Math.PI) v += TWO_PI;
  if (v > Math.PI) v -= TWO_PI;
  return v;
}

export function idx(g: { width: number }, x: number, y: number): number {
  return y * g.width + x;
}

export function inBounds(g: { width: number; height: number }, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < g.width && y < g.height;
}

/** 2x2 回路的残差（单位：整周数，理想为 0，±1 表示存在相位奇点） */
export function residueAt(phase: number[], w: number, x: number, y: number): number {
  const d1 = wrapPhase(phase[idx({ width: w }, x + 1, y)] - phase[idx({ width: w }, x, y)]);
  const d2 = wrapPhase(phase[idx({ width: w }, x + 1, y + 1)] - phase[idx({ width: w }, x + 1, y)]);
  const d3 = wrapPhase(phase[idx({ width: w }, x, y + 1)] - phase[idx({ width: w }, x + 1, y + 1)]);
  const d4 = wrapPhase(phase[idx({ width: w }, x, y)] - phase[idx({ width: w }, x, y + 1)]);
  return Math.round((d1 + d2 + d3 + d4) / TWO_PI);
}

export interface ResidueMap {
  charges: Map<string, number>; // "x,y" -> ±1（位于像素格点右上角坐标系）
}

export function computeResidues(phase: (number | null)[], width: number, height: number): ResidueMap {
  const charges = new Map<string, number>();
  const p = phase.map((v) => (v === null ? 0 : v));
  const valid = phase.map((v) => v !== null);
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const corners = [
        valid[idx({ width }, x, y)],
        valid[idx({ width }, x + 1, y)],
        valid[idx({ width }, x, y + 1)],
        valid[idx({ width }, x + 1, y + 1)],
      ];
      if (!corners.every(Boolean)) continue;
      const r = residueAt(p, width, x, y);
      if (r !== 0) charges.set(`${x},${y}`, r);
    }
  }
  return { charges };
}

/** 沿路径的包裹相位残差（fringe），不闭合则 |值| >= 0.5 */
export function pathResidualFringe(phase: (number | null)[], width: number, path: [number, number][]): number {
  let acc = 0;
  for (let i = 0; i < path.length; i++) {
    const [x1, y1] = path[i];
    const [x2, y2] = path[(i + 1) % path.length];
    const a = phase[idx({ width }, x1, y1)];
    const b = phase[idx({ width }, x2, y2)];
    if (a === null || b === null) return NaN;
    acc += wrapPhase(b - a);
  }
  return acc / TWO_PI;
}

/** 连通区域（4 邻域），只统计有效像素 */
export function connectedRegions(valid: boolean[], width: number, height: number): [number, number][][] {
  const seen = new Array(width * height).fill(false);
  const regions: [number, number][][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx({ width }, x, y);
      if (!valid[i] || seen[i]) continue;
      const region: [number, number][] = [];
      const stack: [number, number][] = [[x, y]];
      seen[i] = true;
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        region.push([cx, cy]);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (!inBounds({ width, height }, nx, ny)) continue;
          const ni = idx({ width }, nx, ny);
          if (!valid[ni] || seen[ni]) continue;
          seen[ni] = true;
          stack.push([nx, ny]);
        }
      }
      regions.push(region);
    }
  }
  return regions;
}

/** 网格数据的规范化摘要（用于内容摘要/展示） */
export function gridDigest(g: GridData): string {
  const total = g.width * g.height;
  const invalid = g.values.filter((v) => v === null).length;
  return `${g.width}x${g.height}@${g.basis} 有效${total - invalid}/${total}`;
}
