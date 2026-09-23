import type { Grid } from './types';
import { canonicalEdgeKey, neighbors4, wrappedDiff, decodeMask } from './grid';
import type { CutNetwork } from './engine-cuts';
import type { QualityResult } from './engine-quality';

export interface RegionForest {
  regions: number[][];
  /** 每像素的根（区域锚点）；无效/低振幅像素不在任何区域 */
  rootOf: Record<number, number>;
  parentEdge: Record<number, [number, number] | null>;
  /** 每条树边记录的主值差分（rad），用于回放路径 */
  treeEdgeDelta: Record<string, number>;
  /** 区域之间被切口阻断的边（多连通/多解都挂在这里） */
  cutCrossEdges: Array<[number, number]>;
  /** 每条非树边（切口边）在展开树中的路径：edgeKey -> 像素路径 */
  paths: Record<string, number[]>;
}

/**
 * 多连通区：在“有效像素且不跨越切口”的图上求连通分量。
 * 每个分量构造以质量为优先级的确定性最大生成树（Prim），
 * 作为该区域的展开树；路径显式保留，供循环残差回放。
 */
export function buildRegionForest(
  phase: Grid,
  mask: Grid,
  quality: QualityResult,
  cuts: CutNetwork,
): RegionForest {
  const b = phase.coordinateBasis;
  const n = b.rows * b.cols;
  const cells = decodeMask(mask);
  const cutSet = new Set(cuts.cutEdges.map(([u, v]) => canonicalEdgeKey(u, v)));
  const blocked = new Set(quality.lowAmplitudePixels);

  const regionOf = new Array<number>(n).fill(-1);
  const regions: number[][] = [];
  for (let start = 0; start < n; start++) {
    if (cells[start] !== 'valid' || blocked.has(start) || regionOf[start] !== -1) continue;
    const region: number[] = [];
    const queue = [start];
    regionOf[start] = regions.length;
    while (queue.length) {
      const p = queue.shift()!;
      region.push(p);
      for (const q of neighbors4(p, b)) {
        if (regionOf[q] !== -1 || cells[q] !== 'valid' || blocked.has(q)) continue;
        if (cutSet.has(canonicalEdgeKey(p, q))) continue;
        regionOf[q] = regionOf[start];
        queue.push(q);
      }
    }
    regions.push(region.sort((a, z) => a - z));
  }

  const rootOf: Record<number, number> = {};
  const parentEdge: Record<number, [number, number] | null> = {};
  const treeEdgeDelta: Record<string, number> = {};
  const paths: Record<string, number[]> = {};
  const cutCrossEdges: Array<[number, number]> = [];

  for (const region of regions) {
    const inRegion = new Set(region);
    // 区域内质量最高像素为根（并列取最小索引，确定）
    const root = region.reduce((best, p) =>
      quality.quality.values[p] > quality.quality.values[best] ? p : best, region[0]);
    const visited = new Set<number>([root]);
    rootOf[root] = root;
    parentEdge[root] = null;
    // Prim：每轮取连接 visited 的最高质量边
    while (visited.size < region.length) {
      let chosen: { from: number; to: number } | null = null;
      let chosenQ = -1;
      for (const u of visited) {
        for (const v of neighbors4(u, b)) {
          if (!inRegion.has(v) || visited.has(v)) continue;
          const q = Math.min(quality.quality.values[u], quality.quality.values[v]);
          if (q > chosenQ || (q === chosenQ && chosen && v < chosen.to)) {
            chosen = { from: u, to: v }; chosenQ = q;
          }
        }
      }
      if (!chosen) break;
      visited.add(chosen.to);
      rootOf[chosen.to] = root;
      parentEdge[chosen.to] = chosen.from < chosen.to ? [chosen.from, chosen.to] : [chosen.to, chosen.from];
      treeEdgeDelta[canonicalEdgeKey(chosen.from, chosen.to)] = wrappedDiff(phase.values[chosen.from], phase.values[chosen.to]);
    }
  }

  // 切口边中，两端都属于有效区域的，是“区域间候选边”
  for (const [u, v] of cuts.cutEdges) {
    if (regionOf[u] !== -1 && regionOf[v] !== -1 && regionOf[u] !== regionOf[v]) {
      cutCrossEdges.push([u, v]);
    }
  }
  // 路径：对每条切口跨边，记录两端在各自树上到根的路径回放由 cycle 模块统一计算
  return { regions, rootOf, parentEdge, treeEdgeDelta, cutCrossEdges, paths };
}

/** 沿 parentEdge 回溯到根，返回像素路径（含端点） */
export function treePath(forest: RegionForest, from: number, to: number): number[] | null {
  if (forest.rootOf[from] !== forest.rootOf[to]) return null;
  const up = (p: number) => {
    const chain: number[] = [];
    let cur = p;
    while (forest.parentEdge[cur] !== null && forest.parentEdge[cur] !== undefined) {
      const pe = forest.parentEdge[cur]!;
      chain.push(cur);
      cur = pe[0] === cur ? pe[1] : pe[0];
    }
    chain.push(cur);
    return chain;
  };
  const a = up(from), bPath = up(to);
  // 公共根拼接（同区域同根）
  return [...a, ...bPath.slice(1)];
}

/** 沿像素路径累加主值差分，得 path 展开差（rad） */
export function pathDelta(phase: Grid, pathPixels: number[]): number {
  let sum = 0;
  for (let i = 0; i < pathPixels.length - 1; i++) {
    sum += wrappedDiff(phase.values[pathPixels[i]], phase.values[pathPixels[i + 1]]);
  }
  return Number(sum.toFixed(12));
}
