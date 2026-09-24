import type { Grid2D, FeasibleRegions, AlgorithmProvenance, FeasibleRegion } from '../domain/types';
import { neighbors } from './residues';

/**
 * 可行域：在“有效像素图”（质量 > 0，即非遮罩且非低振幅）上做连通分量。
 * 多连通：无效像素若形成被有效像素包围的孔洞，则标记 multiConnected 并登记。
 */
export function computeRegions(
  grid: Grid2D,
  quality: number[],
  provenance: AlgorithmProvenance
): FeasibleRegions {
  const n = grid.width * grid.height;
  const pixelRegion: (number | null)[] = new Array(n).fill(null);
  const regions: FeasibleRegion[] = [];

  for (let start = 0; start < n; start++) {
    if (quality[start] <= 0 || pixelRegion[start] !== null) continue;
    const id = regions.length;
    const pixels: number[] = [];
    const stack = [start];
    pixelRegion[start] = id;
    while (stack.length) {
      const i = stack.pop() as number;
      pixels.push(i);
      for (const { n: j } of neighbors(i, grid)) {
        if (quality[j] > 0 && pixelRegion[j] === null) {
          pixelRegion[j] = id;
          stack.push(j);
        }
      }
    }
    regions.push({ id, pixels, enclosesHoles: [] });
  }

  // 孔洞：无效像素的连通分量中，不触碰边界者为被包围孔洞
  const seen = new Array(n).fill(false);
  const holes: number[] = [];
  for (let start = 0; start < n; start++) {
    if (quality[start] > 0 || seen[start]) continue;
    const comp: number[] = [];
    let touchesBorder = false;
    const stack = [start];
    seen[start] = true;
    while (stack.length) {
      const i = stack.pop() as number;
      comp.push(i);
      const x = i % grid.width;
      const y = Math.floor(i / grid.width);
      if (x === 0 || y === 0 || x === grid.width - 1 || y === grid.height - 1) touchesBorder = true;
      for (const { n: j } of neighbors(i, grid)) {
        if (quality[j] <= 0 && !seen[j]) {
          seen[j] = true;
          stack.push(j);
        }
      }
    }
    if (!touchesBorder) {
      const holeId = holes.length;
      holes.push(...comp);
      const owners = new Set(comp.map((i) => pixelRegionOfNeighbor(i, grid, pixelRegion)));
      for (const r of owners) {
        if (r !== null) regions[r].enclosesHoles.push(holeId);
      }
    }
  }

  return {
    kind: 'FeasibleRegions', id: '', provenance, regions, pixelRegion,
    multiConnected: holes.length > 0 || regions.length > 1
  };
}

function pixelRegionOfNeighbor(i: number, grid: Grid2D, pixelRegion: (number | null)[]): number | null {
  for (const { n } of neighbors(i, grid)) {
    const r = pixelRegion[n];
    if (r !== null) return r;
  }
  return null;
}
