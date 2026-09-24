import { Grid, at, idx, wrapPhase, TWO_PI } from './grid';

/**
 * 二维相位展开引擎（确定性）。
 * 领域规则：
 *  - 低振幅区域不得猜相位：质量低于阈值的像素保持未知并附诊断；
 *  - 切口两侧的整周偏移显式表示：每条支路切口携带 offsetAcross；
 *  - 不同展开树可得到局部一致解：保留每像素路径（parent）与循环残差，
 *    两种树序产生分歧的像素进入整周多解候选集。
 */
export interface UnwrapParams {
  qualityThreshold: number;     // 信噪阈值，低于则不得猜相位
  treeOrder: 'row' | 'col';     // 展开树生长顺序（两种树序 -> 两组候选）
  manualCuts?: CutEdge[];       // 来自切口编辑历史的人工切口
}

export interface CutEdge { ax: number; ay: number; bx: number; by: number }

export interface BranchCut {
  id: string;
  edges: CutEdge[];
  /** 切口两侧的显式整周偏移：从 a 侧跨到 b 侧时 k += offsetAcross。 */
  offsetAcross: number;
  origin: 'residue-pairing' | 'manual';
}

export interface CycleResidual { x: number; y: number; residual: number }

export interface Ambiguity { x: number; y: number; candidates: number[] }

export interface Island { id: number; root: { x: number; y: number }; size: number; relativeOffset: number | null }

export interface UnknownPixel { x: number; y: number; reason: string }

export interface UnwrapResult {
  width: number;
  height: number;
  unwrapped: (number | null)[];
  integers: (number | null)[];
  parents: (number | null)[];
  cuts: BranchCut[];
  cycles: CycleResidual[];
  ambiguities: Ambiguity[];
  islands: Island[];
  unknowns: UnknownPixel[];
  diagnostics: string[];
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export function unwrapField(
  wrapped: Grid,
  quality: Grid,
  mask: Grid,
  params: UnwrapParams
): UnwrapResult {
  const { width, height } = wrapped;
  const n = width * height;
  const diagnostics: string[] = [];
  const unknowns: UnknownPixel[] = [];

  const valid = new Array<boolean>(n).fill(false);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(wrapped, x, y);
      const m = mask.data[i];
      const q = quality.data[i];
      const w = wrapped.data[i];
      if (m === 0 || m === null) { unknowns.push({ x, y, reason: 'masked_invalid' }); continue; }
      if (q === null || q < params.qualityThreshold) {
        unknowns.push({ x, y, reason: 'low_amplitude_no_guess' });
        continue;
      }
      if (w === null) { unknowns.push({ x, y, reason: 'missing_phase' }); continue; }
      valid[i] = true;
    }
  }
  if (unknowns.some((u) => u.reason === 'low_amplitude_no_guess')) {
    diagnostics.push('low_amplitude_no_guess');
  }

  // 1) 残差点（2x2 环流）
  interface Residue { x: number; y: number; charge: number }
  const residues: Residue[] = [];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const i00 = idx(wrapped, x, y), i10 = idx(wrapped, x + 1, y);
      const i01 = idx(wrapped, x, y + 1), i11 = idx(wrapped, x + 1, y + 1);
      if (!(valid[i00] && valid[i10] && valid[i01] && valid[i11])) continue;
      const w00 = wrapped.data[i00]!, w10 = wrapped.data[i10]!;
      const w01 = wrapped.data[i01]!, w11 = wrapped.data[i11]!;
      const loop =
        wrapPhase(w10 - w00) + wrapPhase(w11 - w10) +
        wrapPhase(w01 - w11) + wrapPhase(w00 - w01);
      const charge = Math.round(loop / TWO_PI);
      if (charge !== 0) residues.push({ x, y, charge });
    }
  }

  // 2) 支路切口：贪心配对正负残差点，路径取 L 形；每条切口显式记录跨切口整周偏移。
  const cuts: BranchCut[] = [];
  const cutEdgeMap = new Map<string, { cutId: string; offset: number }>();
  function registerCut(edges: CutEdge[], offset: number, origin: BranchCut['origin']): void {
    const id = `cut_${cuts.length}`;
    cuts.push({ id, edges, offsetAcross: offset, origin });
    for (const e of edges) {
      const a = idx(wrapped, e.ax, e.ay), b = idx(wrapped, e.bx, e.by);
      cutEdgeMap.set(edgeKey(a, b), { cutId: id, offset });
    }
  }
  const pos = residues.filter((r) => r.charge > 0);
  const neg = residues.filter((r) => r.charge < 0);
  const usedNeg = new Set<number>();
  for (const p of pos) {
    let best = -1, bestD = Infinity;
    for (let ni = 0; ni < neg.length; ni++) {
      if (usedNeg.has(ni)) continue;
      const d = Math.abs(neg[ni].x - p.x) + Math.abs(neg[ni].y - p.y);
      if (d < bestD) { bestD = d; best = ni; }
    }
    if (best < 0) break;
    usedNeg.add(best);
    const q = neg[best];
    const edges: CutEdge[] = [];
    let cx = p.x, cy = p.y;
    while (cx !== q.x) { const nx = cx + Math.sign(q.x - cx); edges.push({ ax: cx, ay: cy, bx: nx, by: cy }); cx = nx; }
    while (cy !== q.y) { const ny = cy + Math.sign(q.y - cy); edges.push({ ax: cx, ay: cy, bx: cx, by: ny }); cy = ny; }
    if (edges.length > 0) registerCut(edges, -Math.sign(p.charge), 'residue-pairing');
  }
  for (const e of params.manualCuts ?? []) registerCut([e], 1, 'manual');

  // 3) 两种树序展开；保留路径与整周数。
  function growTree(order: 'row' | 'col'): { k: (number | null)[]; phi: (number | null)[]; parent: (number | null)[]; islandOf: (number | null)[] } {
    const k = new Array<number | null>(n).fill(null);
    const phi = new Array<number | null>(n).fill(null);
    const parent = new Array<number | null>(n).fill(null);
    const islandOf = new Array<number | null>(n).fill(null);
    const seeds: number[] = [];
    for (let i = 0; i < n; i++) if (valid[i]) seeds.push(i);
    seeds.sort((a, b) => (quality.data[b] ?? 0) - (quality.data[a] ?? 0));
    let island = 0;
    const dirs = order === 'row'
      ? [[1, 0], [0, 1], [-1, 0], [0, -1]]
      : [[0, 1], [1, 0], [0, -1], [-1, 0]];
    for (const seed of seeds) {
      if (k[seed] !== null) continue;
      k[seed] = 0; phi[seed] = wrapped.data[seed]!; islandOf[seed] = island;
      const queue = [seed];
      while (queue.length) {
        const cur = queue.shift()!;
        const cx = cur % width, cy = Math.floor(cur / width);
        for (const [dx, dy] of dirs) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (!valid[ni] || k[ni] !== null) continue;
          const cut = cutEdgeMap.get(edgeKey(cur, ni));
          const grad = wrapPhase(wrapped.data[ni]! - wrapped.data[cur]!);
          const jump = cut ? cut.offset : 0;
          k[ni] = k[cur]! + Math.round((grad - (wrapped.data[ni]! - wrapped.data[cur]!)) / TWO_PI) + jump;
          phi[ni] = wrapped.data[ni]! + TWO_PI * k[ni]!;
          parent[ni] = cur; islandOf[ni] = island;
          queue.push(ni);
        }
      }
      island++;
    }
    return { k, phi, parent, islandOf };
  }

  const treeA = growTree(params.treeOrder);
  const treeB = growTree(params.treeOrder === 'row' ? 'col' : 'row');

  // 4) 整周多解：两棵树给出不同 k 的像素保留全部合法候选。
  const ambiguities: Ambiguity[] = [];
  for (let i = 0; i < n; i++) {
    const a = treeA.k[i], b = treeB.k[i];
    if (a !== null && b !== null && a !== b) {
      ambiguities.push({ x: i % width, y: Math.floor(i / width), candidates: [a, b].sort((p, q) => p - q) });
    }
  }
  if (ambiguities.length > 0) diagnostics.push('integer_ambiguity');

  // 5) 循环残差：包裹梯度沿 2x2 环的环流，减去环上切口显式整周补偿；
  //    残差点若无切口穿过则环不闭合，残差显式记录。
  const cycles: CycleResidual[] = [];
  const loopSteps = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const corners = [
        idx(wrapped, x, y), idx(wrapped, x + 1, y),
        idx(wrapped, x + 1, y + 1), idx(wrapped, x, y + 1)
      ];
      if (!corners.every((c) => valid[c])) continue;
      let circulation = 0, cutComp = 0;
      for (let s = 0; s < 4; s++) {
        const a = corners[s], b = corners[(s + 1) % 4];
        circulation += wrapPhase(wrapped.data[b]! - wrapped.data[a]!);
        const cut = cutEdgeMap.get(edgeKey(a, b));
        if (cut) cutComp += (a < b ? cut.offset : -cut.offset) * TWO_PI;
      }
      const residual = circulation - cutComp;
      if (Math.abs(residual) > 1e-9) cycles.push({ x, y, residual });
    }
  }
  if (cycles.length > 0) diagnostics.push('cycle_inconsistency');

  // 6) 多连通区：各岛独立展开，岛间整周偏移未知。
  const islandCount = new Map<number, number>();
  let maxIsland = -1;
  for (let i = 0; i < n; i++) {
    const isl = treeA.islandOf[i];
    if (isl === null) continue;
    islandCount.set(isl, (islandCount.get(isl) ?? 0) + 1);
    maxIsland = Math.max(maxIsland, isl);
  }
  const islands: Island[] = [];
  for (let isl = 0; isl <= maxIsland; isl++) {
    const size = islandCount.get(isl);
    if (!size) continue;
    let root = -1;
    for (let i = 0; i < n; i++) if (treeA.islandOf[i] === isl && treeA.parent[i] === null) { root = i; break; }
    islands.push({
      id: isl,
      root: { x: root % width, y: Math.floor(root / width) },
      size,
      relativeOffset: isl === 0 ? 0 : null
    });
  }
  if (islands.length > 1) diagnostics.push('multi_connected_region');

  const unknownSet = new Set(unknowns.map((u) => u.y * width + u.x));
  const unwrapped = treeA.phi.map((v, i) => (valid[i] && !unknownSet.has(i) ? v : null));

  return {
    width, height,
    unwrapped,
    integers: treeA.k,
    parents: treeA.parent,
    cuts, cycles, ambiguities, islands, unknowns, diagnostics
  };
}
