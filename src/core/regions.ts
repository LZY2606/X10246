import { edgeId, neighbors4 } from "./grid";
import type { BranchCutNetwork, InvalidMask, RegionMap, ConnectedRegion } from "../shared/types";

/**
 * 有效像素图：遮罩孔洞与支路切口（两侧不得跨越）均为禁用边。
 * 4-邻域 BFS 得到连通区；被孔洞/边界/切口环绕的区域 bounded=true（多连通检测基础）。
 */
export function buildRegions(
  rows: number,
  cols: number,
  mask: InvalidMask,
  cuts: BranchCutNetwork
): RegionMap {
  const n = rows * cols;
  const cutEdges = new Set(cuts.cuts.map((c) => c.edgeId));
  const labels = new Int32Array(n).fill(-1);
  const invalidPixels: number[] = [];

  for (let i = 0; i < n; i++) {
    if (mask.invalid[i]) {
      labels[i] = -2;
      invalidPixels.push(i);
    }
  }

  const regions: ConnectedRegion[] = [];
  let regionCount = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1) continue;
    const regionId = `R${regionCount}`;
    const queue = [start];
    labels[start] = regionCount;
    const pixels: number[] = [];
    let touchesBorder = false;

    while (queue.length) {
      const cur = queue.shift()!;
      pixels.push(cur);
      const [r, c] = [Math.floor(cur / cols), cur % cols];
      if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) touchesBorder = true;
      for (const nb of neighbors4(cur, rows, cols)) {
        if (labels[nb] !== -1) continue;
        if (cutEdges.has(edgeId(cur, nb))) continue;
        labels[nb] = regionCount;
        queue.push(nb);
      }
    }
    regions.push({ regionId, pixels: pixels.sort((a, b) => a - b), bounded: !touchesBorder });
    regionCount++;
  }
  invalidPixels.sort((a, b) => a - b);
  return { kind: "region_map", regions, invalidPixels };
}
