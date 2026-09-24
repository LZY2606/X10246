import { TWO_PI } from '../domain/units';
import type {
  Grid2D, AlgorithmProvenance, UnwrapTree, TreeEdge, CycleClosure,
  FeasibleRegions, CutNetwork, QualityMap
} from '../domain/types';
import { neighbors } from './residues';

/** 边 (a -> b) 上的整周增量：使 (φb + 2π·nb) - (φa + 2π·na) ∈ (-π, π] */
export function orderStepAcross(phaseA: number, phaseB: number): number {
  const delta = wrapDelta(phaseB, phaseA);
  return (delta - (phaseB - phaseA)) / TWO_PI;
}

export function wrapDelta(a: number, b: number): number {
  let d = a - b;
  while (d <= -Math.PI) d += TWO_PI;
  while (d > Math.PI) d -= TWO_PI;
  return d;
}

/** 像素邻边是否落在切口上：返回切口边下标或 null */
export function cutEdgeBetween(cuts: CutNetwork, a: number, b: number, w: number, h: number): number | null {
  const ax = a % w;
  const ay = Math.floor(a / w);
  const bx = b % w;
  const by = Math.floor(b / w);
  for (let ei = 0; ei < cuts.edges.length; ei++) {
    const e = cuts.edges[ei];
    const x1 = Math.min(e.a[0], e.b[0]);
    const x2 = Math.max(e.a[0], e.b[0]);
    const y1 = Math.min(e.a[1], e.b[1]);
    const y2 = Math.max(e.a[1], e.b[1]);
    // 水平像素边 (ax,ay)-(bx,by)，边位于 plaquette 行 ay-1/ay 之间
    if (ay === by) {
      const cx = Math.min(ax, bx);
      for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
          if (cx === x && (ay === y || ay === y + 1) && y + 1 < h) return ei;
        }
      }
    } else if (ax === bx) {
      const cy = Math.min(ay, by);
      for (let x = x1; x <= x2; x++) {
        for (let y = y1; y <= y2; y++) {
          if (cy === y && (ax === x || ax === x + 1) && x + 1 < w) return ei;
        }
      }
    }
  }
  return null;
}

/**
 * 最小代价生成树展开（每个可行域一棵）：
 *  - 只在质量 > 0 的像素间生长（低振幅/无效像素不参与，绝不猜相位）
 *  - 跨越切口的边不进树；切口两侧整周偏移显式留在 CutNetwork / Candidate
 */
export function buildUnwrapTree(
  grid: Grid2D,
  phase: (number | null)[],
  qualityMap: QualityMap,
  regions: FeasibleRegions,
  cuts: CutNetwork,
  regionId: number,
  provenance: AlgorithmProvenance
): UnwrapTree {
  const w = grid.width;
  const n = w * grid.height;
  const region = regions.regions[regionId];
  if (!region) throw new Error(`unknown region ${regionId}`);
  const inRegion = new Set(region.pixels);

  const rootPixel = region.pixels.reduce(
    (best, i) => (qualityMap.quality[i] > qualityMap.quality[best] ? i : best),
    region.pixels[0]
  );
  const parent: (number | null)[] = new Array(n).fill(null);
  const inTree = new Set<number>([rootPixel]);
  const edges: TreeEdge[] = [];

  // 确定性 Prim（代价相同则按像素索引，保证固定 seed 可复现）
  while (true) {
    let chosen: { a: number; b: number; step: number; cost: number } | null = null;
    for (const a of inTree) {
      for (const { n: b } of neighbors(a, grid)) {
        if (!inRegion.has(b) || inTree.has(b)) continue;
        if (cutEdgeBetween(cuts, a, b, w, grid.height) !== null) continue;
        const pa = phase[a];
        const pb = phase[b];
        if (pa === null || pb === null) continue;
        const step = orderStepAcross(pa, pb);
        const cost = 1 / Math.max(1e-6, qualityMap.quality[a] * qualityMap.quality[b]);
        if (!chosen || cost < chosen.cost - 1e-12 ||
            (Math.abs(cost - chosen.cost) <= 1e-12 && (a < chosen.a || (a === chosen.a && b < chosen.b)))) {
          chosen = { a, b, step, cost };
        }
      }
    }
    if (!chosen) break;
    inTree.add(chosen.b);
    parent[chosen.b] = chosen.a;
    edges.push({ a: chosen.a, b: chosen.b, orderStep: chosen.step, crossesCut: false, cutEdgeIndex: null });
  }

  const integerOrder: (number | null)[] = new Array(n).fill(null);
  const unwrappedRad: (number | null)[] = new Array(n).fill(null);
  integerOrder[rootPixel] = 0;
  for (const node of topoByParent(parent, [...inTree], rootPixel)) {
    const p = parent[node];
    if (p === null) continue;
    const step = edges.find((e) => e.a === p && e.b === node)?.orderStep ?? 0;
    integerOrder[node] = (integerOrder[p] as number) + step;
  }
  for (const i of inTree) {
    if (phase[i] !== null && integerOrder[i] !== null) {
      unwrappedRad[i] = (phase[i] as number) + (integerOrder[i] as number) * TWO_PI;
    }
  }

  return {
    kind: 'UnwrapTree', id: '', provenance, regionId, rootPixel,
    edges, parent, integerOrder, unwrappedRad
  };
}

function topoByParent(parent: (number | null)[], nodes: number[], root: number): number[] {
  const depth = new Map<number, number>();
  const getDepth = (i: number): number => {
    const cached = depth.get(i);
    if (cached !== undefined) return cached;
    let d = 0;
    let cur: number | null = i;
    while (cur !== null && cur !== root) {
      cur = parent[cur];
      d++;
    }
    depth.set(i, d);
    return d;
  };
  return [...nodes].sort((a, b) => getDepth(a) - getDepth(b) || a - b);
}

/**
 * 循环闭合：每条非树边（弦）比较直连整周增量与沿树路径的累积差；
 * 残差非零 => 循环不闭合。plaquette 残差同样作为循环残差保留。
 */
export function checkCycleClosure(
  grid: Grid2D,
  phase: (number | null)[],
  tree: UnwrapTree,
  regions: FeasibleRegions,
  cuts: CutNetwork,
  residueCharge: number[],
  provenance: AlgorithmProvenance
): CycleClosure {
  const w = grid.width;
  const region = new Set(regions.regions[tree.regionId].pixels);
  const chords: CycleClosure['chords'] = [];
  let maxAbs = 0;

  for (const a of region) {
    for (const { n: b } of neighbors(a, grid)) {
      if (b <= a || !region.has(b)) continue;
      const inTreeEdge = tree.edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
      if (inTreeEdge) continue;
      const pa = phase[a];
      const pb = phase[b];
      if (pa === null || pb === null) continue;
      const directStep = orderStepAcross(pa, pb);
      const path = treePath(tree.parent, a, b);
      const oa = tree.integerOrder[a];
      const ob = tree.integerOrder[b];
      const treePathOrder = oa !== null && ob !== null ? ob - oa : 0;
      const residual = treePathOrder - directStep;
      maxAbs = Math.max(maxAbs, Math.abs(residual));
      chords.push({ a, b, directOrderStep: directStep, treePathOrder, residualOrders: residual, path });
    }
  }

  const plaquetteCycles: CycleClosure['plaquetteCycles'] = [];
  for (let py = 0; py < grid.height - 1; py++) {
    for (let px = 0; px < grid.width - 1; px++) {
      const q = residueCharge[py * (w - 1) + px];
      if (q !== 0) plaquetteCycles.push({ at: [px, py], charge: q });
    }
  }
  void cuts;

  return {
    kind: 'CycleClosure', id: '', provenance, chords, plaquetteCycles,
    closed: maxAbs === 0 && plaquetteCycles.length === 0,
    maxAbsResidual: maxAbs
  };
}

function treePath(parent: (number | null)[], a: number, b: number): number[] {
  const ancA: number[] = [];
  let cur: number | null = a;
  while (cur !== null) {
    ancA.push(cur);
    cur = parent[cur];
  }
  const ancB: number[] = [];
  cur = b;
  while (cur !== null) {
    ancB.push(cur);
    cur = parent[cur];
  }
  const setA = new Set(ancA);
  let lca: number | null = null;
  for (const x of ancB) {
    if (setA.has(x)) {
      lca = x;
      break;
    }
  }
  if (lca === null) return [a, b];
  const up = ancA.slice(0, ancA.indexOf(lca) + 1);
  const down = ancB.slice(0, ancB.indexOf(lca)).reverse();
  return [...up, ...down];
}
