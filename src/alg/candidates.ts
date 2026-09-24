import { TWO_PI } from '../domain/units';
import type {
  Grid2D, AlgorithmProvenance, UnwrapCandidate, UnwrapTree, CutNetwork,
  FeasibleRegions, CutEdge
} from '../domain/types';

/**
 * 整周候选枚举：
 *  1) k=0：以树根部整周数为基准的候选；
 *  2) k∈[-K,K]：整周平移的全部合法候选（无法唯一决定时全部保留，
 *     切口两侧的整周偏移随平移显式给出）。
 * 候选一律 proposed，等待人工裁定，绝不自动“挑一个看起来对的”。
 */
export function enumerateCandidates(
  grid: Grid2D,
  tree: UnwrapTree,
  cuts: CutNetwork,
  regions: FeasibleRegions,
  provenance: AlgorithmProvenance,
  options: { translationRange: number }
): UnwrapCandidate[] {
  const n = grid.width * grid.height;
  const inRegion = new Set(regions.regions[tree.regionId].pixels);
  const baseOrders: (number | null)[] = new Array(n).fill(null);
  for (const i of inRegion) baseOrders[i] = tree.integerOrder[i];

  const candidates: UnwrapCandidate[] = [];
  const K = options.translationRange;
  for (let k = -K; k <= K; k++) {
    const orders: (number | null)[] = baseOrders.map((o) => (o === null ? null : o + k));
    const unwrappedRad: (number | null)[] = new Array(n).fill(null);
    for (const i of inRegion) {
      if (tree.unwrappedRad[i] !== null) {
        unwrappedRad[i] = (tree.unwrappedRad[i] as number) + k * TWO_PI;
      }
    }
    candidates.push({
      kind: 'UnwrapCandidate', id: '', provenance,
      treeId: tree.id, regionId: tree.regionId,
      anchorPixel: k === 0 ? tree.rootPixel : null,
      anchorOrder: k,
      orders, unwrappedRad,
      cutAssignments: cuts.edges
        .map((e, ei) => ({ edgeIndex: ei, integerOrderAcross: evaluateCutOffset(e, grid, orders) }))
        .filter((a) => a.integerOrderAcross !== null) as { edgeIndex: number; integerOrderAcross: number }[],
      status: 'proposed',
      rejectReason: null,
      ambiguityTag: K > 0 ? `global-order-shift:${k}` : null
    });
  }
  return candidates;
}

/** 切口端点对应像素（plaquette 左上/右下代表）的整周差 */
function evaluateCutOffset(edge: CutEdge, grid: Grid2D, orders: (number | null)[]): number | null {
  const w = grid.width;
  const [x1, y1] = edge.a;
  const [x2, y2] = edge.b;
  const pxA = y1 * w + Math.min(x1, w - 1);
  const pxB = Math.min(y2, grid.height - 1) * w + Math.min(x2, w - 1);
  const oa = orders[pxA];
  const ob = orders[pxB];
  if (oa === null || ob === null) return null;
  return ob - oa;
}
