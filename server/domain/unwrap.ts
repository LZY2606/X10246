import type {
  CutNetworkPayload, EdgeRef, Grid2D, LoopResidual, MaskGrid,
  QualityMapPayload, ResiduePoint, UnwrapCandidatePayload,
} from '../../shared/types';
import { idx, neighbors, TWO_PI, wrapPhase } from './grids';

export const CUT_ALGORITHM = 'branchcut-v1';
export const UNWRAP_ALGORITHM = 'unwrap-tree-v1';
export const LOOP_ALGORITHM = 'loop-residual-v1';

function edgeKey(e: EdgeRef): string { return `${e.x},${e.y},${e.dir}`; }

/** 计算 Goldstein 残差：每个 2x2 回路的包裹差分和（单位：整周）。 */
export function computeResidues(phase: Grid2D, unknown: boolean[]): ResiduePoint[] {
  const residues: ResiduePoint[] = [];
  for (let y = 0; y < phase.height - 1; y++) {
    for (let x = 0; x < phase.width - 1; x++) {
      const a = idx(phase, x, y), b = idx(phase, x + 1, y);
      const c = idx(phase, x + 1, y + 1), d = idx(phase, x, y + 1);
      if (unknown[a] || unknown[b] || unknown[c] || unknown[d]) continue;
      const sum =
        wrapPhase(phase.values[b] - phase.values[a]) +
        wrapPhase(phase.values[c] -phase.values[b]) +
        wrapPhase(phase.values[d] - phase.values[c]) +
        wrapPhase(phase.values[a] - phase.values[d]);
      const charge = Math.round(sum / TWO_PI);
      if (charge !== 0) residues.push({ x, y, charge });
    }
  }
  return residues;
}

/**
 * 支路切口：贪心配对正负残差（曼哈顿路径），叠加人工切口编辑历史。
 * 切口边不可被展开路径跨越。
 */
export function computeCutNetwork(
  phase: Grid2D,
  quality: QualityMapPayload,
  manualEdits: Array<{ op: 'add_cut' | 'remove_cut'; edge: EdgeRef }>,
): CutNetworkPayload {
  const residues = computeResidues(phase, quality.unknownMask);
  const cuts = new Set<string>();
  const pos = residues.filter((r) => r.charge > 0);
  const neg = residues.filter((r) => r.charge < 0);
  const usedNeg = new Set<number>();
  for (const p of pos) {
    let best = -1; let bestD = Infinity;
    for (let i = 0; i < neg.length; i++) {
      if (usedNeg.has(i)) continue;
      const d = Math.abs(neg[i].x - p.x) + Math.abs(neg[i].y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) continue;
    usedNeg.add(best);
    const n = neg[best];
    // 曼哈顿路径：先 x 后 y，路径边记为切口
    let cx = p.x, cy = p.y;
    while (cx !== n.x) { const nx = cx + Math.sign(n.x - cx); cuts.add(edgeKey({ x: Math.min(cx, nx), y: cy, dir: 'v' })); cx = nx; }
    while (cy !== n.y) { const ny = cy + Math.sign(n.y - cy); cuts.add(edgeKey({ x: cx, y: Math.min(cy, ny), dir: 'h' })); cy = ny; }
  }
  const manual: EdgeRef[] = [];
  for (const e of manualEdits) {
    if (e.op === 'add_cut') { cuts.add(edgeKey(e.edge)); manual.push(e.edge); }
    else { cuts.delete(edgeKey(e.edge)); }
  }
  return {
    residues,
    cutEdges: [...cuts].map((k) => { const [x, y, dir] = k.split(','); return { x: +x, y: +y, dir: dir as 'h' | 'v' }; }),
    manualCutEdges: manual,
  };
}

function crossesCut(cuts: Set<string>, x: number, y: number, nx: number, ny: number): boolean {
  if (nx === x + 1) return cuts.has(edgeKey({ x, y, dir: 'v' }));
  if (nx === x - 1) return cuts.has(edgeKey({ x: nx, y, dir: 'v' }));
  if (ny === y + 1) return cuts.has(edgeKey({ x, y: ny - 1 < y ? ny : y, dir: 'h' }));
  if (ny === y - 1) return cuts.has(edgeKey({ x, y: ny, dir: 'h' }));
  return false;
}

/**
 * 多树展开：BFS 洪水填充，避开切口与未知区。
 * - 低振幅/遮罩未知区输出 NaN（不得猜相位）；
 * - 多连通区各自独立定整周基准（显式 integerOffsets）；
 * - 不同 treeOrder 产生不同展开树 => 不同候选。
 */
export function unwrapCandidate(
  phase: Grid2D,
  quality: QualityMapPayload,
  cuts: CutNetworkPayload,
  treeOrder: string,
  seed?: { x: number; y: number },
): UnwrapCandidatePayload {
  const w = phase.width, h = phase.height;
  const cutSet = new Set(cuts.cutEdges.map(edgeKey));
  const k = new Array<number>(w * h).fill(Number.NaN);   // 整周数
  const regionOf = new Array<number>(w * h).fill(-1);
  const dirs = neighbors(treeOrder);
  const offsets: UnwrapCandidatePayload['integerOffsets'] = [];
  let regionId = 0;

  const start = seed ?? (() => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!quality.unknownMask[idx(phase, x, y)]) return { x, y };
    return { x: 0, y: 0 };
  })();

  const trySeed = (sx: number, sy: number): boolean => {
    const si = idx(phase, sx, sy);
    if (quality.unknownMask[si] || regionOf[si] >= 0) return false;
    const queue: Array<[number, number]> = [[sx, sy]];
    k[si] = 0; regionOf[si] = regionId;
    while (queue.length) {
      const [x, y] = queue.shift()!;
      const i = idx(phase, x, y);
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = idx(phase, nx, ny);
        if (quality.unknownMask[ni] || regionOf[ni] >= 0) continue;
        if (crossesCut(cutSet, x, y, nx, ny)) continue;
        k[ni] = k[i] + Math.round((phase.values[i] + wrapPhase(phase.values[ni] - phase.values[i]) - phase.values[ni]) / TWO_PI);
        regionOf[ni] = regionId;
        queue.push([nx, ny]);
      }
    }
    offsets.push({ regionId, offsetTurns: 0, acrossCut: null });
    regionId++;
    return true;
  };

  trySeed(start.x, start.y);
  // 多连通区：剩余未知连通分量各自播种，整周基准独立
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) trySeed(x, y);

  // 切口两侧的显式整周偏移：跨切口邻居的 k 差
  for (const e of cuts.cutEdges) {
    const pairs: Array<[number, number, number, number]> = e.dir === 'v'
      ? [[e.x, e.y, e.x + 1, e.y]] : [[e.x, e.y, e.x, e.y + 1]];
    for (const [ax, ay, bx, by] of pairs) {
      if (bx >= w || by >= h) continue;
      const ai = idx(phase, ax, ay), bi = idx(phase, bx, by);
      if (regionOf[ai] < 0 || regionOf[bi] < 0) continue;
      const diff = Math.round((k[bi] + (phase.values[bi] - phase.values[ai]) / TWO_PI) - k[ai]);
      offsets.push({ regionId: regionOf[bi], offsetTurns: diff, acrossCut: e });
    }
  }

  const unwrapped: Grid2D = {
    width: w, height: h, unit: 'rad', datum: phase.datum,
    values: phase.values.map((v, i) => (regionOf[i] < 0 ? Number.NaN : v + TWO_PI * k[i])),
  };
  return {
    seed: start, treeOrder, unwrapped, integerOffsets: offsets,
    regionCount: regionId, loopResiduals: [], ambiguityGroup: null,
  };
}

/** 循环残差：沿每个 2x2 回路对展开后相位求和，非零即不闭合。 */
export function computeLoopResiduals(candidate: UnwrapCandidatePayload, quality: QualityMapPayload): LoopResidual[] {
  const g = candidate.unwrapped;
  const loops: LoopResidual[] = [];
  for (let y = 0; y < g.height - 1; y++) {
    for (let x = 0; x < g.width - 1; x++) {
      const a = idx(g, x, y), b = idx(g, x + 1, y), c = idx(g, x + 1, y + 1), d = idx(g, x, y + 1);
      if (quality.unknownMask[a] || quality.unknownMask[b] || quality.unknownMask[c] || quality.unknownMask[d]) continue;
      const vs = [g.values[a], g.values[b], g.values[c], g.values[d]];
      if (vs.some((v) => Number.isNaN(v))) continue;
      const sum = (vs[1] - vs[0]) + (vs[2] - vs[1]) + (vs[3] - vs[2]) + (vs[0] - vs[3]);
      const cycles = Math.round(sum / TWO_PI);
      if (cycles !== 0) {
        loops.push({
          loopId: `loop_${x}_${y}`,
          path: [{ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }, { x, y: y + 1 }],
          residualCycles: cycles,
        });
      }
    }
  }
  return loops;
}
