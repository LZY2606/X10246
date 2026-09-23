import type { Grid, CycleResidual, IntegerOffsetCandidate } from './types';
import { TWO_PI, canonicalEdgeKey, wrap, decodeMask } from './grid';
import type { RegionForest } from './engine-tree';
import { treePath, pathDelta } from './engine-tree';

export interface CycleReport {
  cycles: CycleResidual[];
  /** 每条切口跨边的整周候选表 */
  offsets: Array<{ edge: [number, number]; candidates: IntegerOffsetCandidate[]; note: string }>;
}

/**
 * 循环残差：对每条连接两个区域的切口跨边 (u,v)，
 * 环路 = 树上从 u 到锚点路径 + 跨边 + v 侧路径。
 * 多连通区两侧树并不连通，所以环路“不闭合”——这是真实物理状态，
 * closed=false 且 residual=null（不猜 0）。
 * 若切口边两端恰在同一区域（偶极子短路），环路闭合，残差 = wrap(direct) - treeDelta。
 */
export function evaluateCycles(
  phase: Grid,
  mask: Grid,
  forest: RegionForest,
  maxK = 6,
): CycleReport {
  const cells = decodeMask(mask);
  const cycles: CycleResidual[] = [];
  const offsets: CycleReport['offsets'] = [];

  for (const [u, v] of forest.cutCrossEdges) {
    const cycleId = `cyc:${canonicalEdgeKey(u, v)}`;
    const edges: Array<[number, number]> = [[u, v]];
    const sameRegion = forest.rootOf[u] === forest.rootOf[v];
    const pathPixels = treePath(forest, u, v);

    if (!sameRegion || !pathPixels) {
      // 多连通：无法形成闭合环路
      cycles.push({
        cycleId, edges,
        residualRad: null, windingFraction: null,
        closed: false,
        nonClosureReason: regionsDifferReason(forest, u, v, cells),
      });
      offsets.push({
        edge: [u, v],
        candidates: enumerateCandidates(phase, u, v, null),
        note: '多连通区：切口两侧无共同展开树，整周 k 无法唯一决定，保留全部合法候选',
      });
      continue;
    }

    // 同区域：闭合环路，树路径与直连边比较
    const treeD = pathDelta(phase, pathPixels);
    const directD = wrap(phase.values[v] - phase.values[u]);
    let residual = wrap(directD - treeD);
    if (Math.abs(residual) < 1e-9) residual = 0;
    const winding = Math.round((directD - treeD) / TWO_PI);
    const closed = Math.abs(residual) < 1e-6;
    cycles.push({
      cycleId, edges,
      residualRad: closed ? 0 : Number(residual.toFixed(9)),
      windingFraction: winding,
      closed,
      nonClosureReason: closed ? null : `环路累加相差 ${residual.toFixed(4)} rad（非整周）`,
    });
    offsets.push({
      edge: [u, v],
      candidates: enumerateCandidates(phase, u, v, winding),
      note: closed ? '偶极子短路：切口两侧整周偏移被残差唯一约束' : '循环不闭合：残差非整周，所有 k 仅给出代价排序',
    });
  }

  return { cycles, offsets };
}

function regionsDifferReason(forest: RegionForest, u: number, v: number, cells: ReturnType<typeof decodeMask>): string {
  if (cells[u] !== 'valid' || cells[v] !== 'valid') return '切口边端点落在无效/低振幅像素，禁止跨孔洞猜相位';
  return `像素 ${u} 属于区域锚点 ${forest.rootOf[u]}，像素 ${v} 属于区域锚点 ${forest.rootOf[v]}，展开树不连通`;
}

/**
 * 整周候选：切口两侧的真实相位差满足 Δ_true = wrap(d) + 2πk。
 * 若有闭合环路约束，|k|<=maxK 中仅与 winding 相等者为 legal（其余带拒绝原因）；
 * 若无约束（多连通/循环不闭合），|k|<=maxK 全部 legal_undecided，
 * 代价按 |wrap(d)+2πk| 对 0 的接近程度（多解时无法唯一决定）。
 */
function enumerateCandidates(phase: Grid, u: number, v: number, winding: number | null): IntegerOffsetCandidate[] {
  const d = wrap(phase.values[v] - phase.values[u]);
  const maxK = 6;
  const out: IntegerOffsetCandidate[] = [];
  for (let k = -maxK; k <= maxK; k++) {
    if (winding === null) {
      out.push({ k, status: 'legal_undecided', rejectionReason: null, cost: Number(Math.abs(d + TWO_PI * k).toFixed(6)) });
    } else if (k === winding) {
      out.push({ k, status: 'legal_undecided', rejectionReason: null, cost: 0 });
    } else {
      out.push({ k, status: 'rejected', rejectionReason: `与闭合环路整周数 ${winding} 冲突`, cost: null });
    }
  }
  return out;
}

/** 展开表面：区域内沿树累加；低振幅/无效像素保持 unknown（不插值、不猜） */
export function unwrapSurface(
  phase: Grid,
  mask: Grid,
  forest: RegionForest,
): { unwrapped: Grid; unknownPixels: number[] } {
  const b = phase.coordinateBasis;
  const n = b.rows * b.cols;
  const cells = decodeMask(mask);
  const values = new Array<number>(n).fill(NaN);
  const unknown: number[] = [];

  for (const region of forest.regions) {
    const root = forest.rootOf[region[0]];
    values[root] = phase.values[root];
    for (const p of region) {
      if (p === root) continue;
      const pe = forest.parentEdge[p]!;
      const parent = pe[0] === p ? pe[1] : pe[0];
      const d = forest.treeEdgeDelta[canonicalEdgeKey(p, parent)];
      values[p] = Number((values[parent] + d).toFixed(9));
    }
  }
  for (let p = 0; p < n; p++) {
    if (Number.isNaN(values[p]) || cells[p] !== 'valid') {
      if (!Number.isNaN(values[p])) values[p] = NaN;
      unknown.push(p);
    }
  }
  return {
    unwrapped: { values: values.map((x) => (Number.isNaN(x) ? NaN : x)), unit: 'rad', coordinateBasis: b, encoding: 'float64' },
    unknownPixels: unknown,
  };
}
