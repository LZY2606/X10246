import type {
  AmplitudeFrame,
  BranchCutNetwork,
  CalibrationSurface,
  CutEdge,
  CycleResidual,
  CycleResidualSet,
  HeightChainStep,
  HeightField,
  IlluminationGeometry,
  IntegerCandidate,
  IntegerCandidateSet,
  InvalidMask,
  QualityScoreMap,
  Residue,
  ResidueChargeMap,
  SourceRef,
  TreeEdge,
  UnwrappedSolution,
  UnwrapTree,
  Wavelength,
  WrappedPhaseFrame,
} from '../domain/types.js';
import { contentHash, parameterFingerprint, stableId } from '../domain/hash.js';
import { TWO_PI } from '../domain/units.js';

export const ENGINE_VERSION = 'unwrap/branch-cut@3';

export interface UnwrapParams {
  /** 振幅低于此阈值（按最大振幅比例）的像素：不猜相位 */
  lowAmplitudeRatio: number;
  /** 信噪评分低于此值：不猜相位 */
  qualityFloor: number;
  /** 用最近邻配对连接异号残差；超过此曼哈顿距离则连到边界 */
  maxDipoleDistance: number;
}

export const DEFAULT_PARAMS: UnwrapParams = {
  lowAmplitudeRatio: 0.15,
  qualityFloor: 0.2,
  maxDipoleDistance: 4,
};

export interface EngineInputs {
  wrapped: WrappedPhaseFrame;
  amplitude: AmplitudeFrame;
  quality: QualityScoreMap;
  invalid: InvalidMask;
  cutHistory: { added: CutEdge[]; removed: string[] }[];
  params: UnwrapParams;
}

interface GridCtx {
  rows: number;
  cols: number;
  phase: Float64Array; // NaN = 原相位非有限
  amp: Float64Array;
  qual: Float64Array;
  blocked: Uint8Array; // 1 = 无效遮罩 / 低振幅孔洞 / 低质量：不猜相位
  blockReason: string[];
  ampThreshold: number;
}

const wrap = (d: number): number => {
  let w = d % TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  if (w <= -Math.PI) w += TWO_PI;
  return w;
};
const idx = (cols: number, r: number, c: number): number => r * cols + c;

function buildGrid(x: EngineInputs): GridCtx {
  const { rows, cols } = x.wrapped.coordinateBasis;
  const n = rows * cols;
  const phase = new Float64Array(x.wrapped.values);
  const amp = new Float64Array(x.amplitude.values.map((v) => (Number.isFinite(v) ? v : 0)));
  const qual = new Float64Array(x.quality.values.map((v) => (Number.isFinite(v) ? v : 0)));
  const maxAmp = amp.reduce((m, v) => Math.max(m, v), 0);
  const ampThreshold = maxAmp * x.params.lowAmplitudeRatio;
  const blocked = new Uint8Array(n);
  const blockReason = new Array<string>(n).fill('');
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    if (x.invalid.invalid[i]) {
      blocked[i] = 1;
      blockReason[i] = x.invalid.reason[i] ?? 'invalid-mask';
    } else if (amp[i] < ampThreshold) {
      blocked[i] = 1;
      blockReason[i] = `low-amplitude-hole (amp=${amp[i].toFixed(3)} < threshold=${ampThreshold.toFixed(3)})`;
      void r;
      void c;
    } else if (qual[i] < x.params.qualityFloor) {
      blocked[i] = 1;
      blockReason[i] = `low-quality (q=${qual[i].toFixed(3)} < floor=${x.params.qualityFloor})`;
    }
  }
  return { rows, cols, phase, amp, qual, blocked, blockReason, ampThreshold };
}

// ---------------------------------------------------------------------------
// 1. 残差电荷图：每个 2x2 回路的包裹梯度卷绕和
// ---------------------------------------------------------------------------

export function computeResidues(x: EngineInputs, createdAt: string): ResidueChargeMap {
  const g = buildGrid(x);
  const residues: Residue[] = [];
  let positiveCount = 0;
  let negativeCount = 0;
  for (let r = 0; r < g.rows - 1; r++) {
    for (let c = 0; c < g.cols - 1; c++) {
      const p00 = g.phase[idx(g.cols, r, c)];
      const p01 = g.phase[idx(g.cols, r, c + 1)];
      const p10 = g.phase[idx(g.cols, r + 1, c)];
      const p11 = g.phase[idx(g.cols, r + 1, c + 1)];
      if ([p00, p01, p10, p11].some((p) => !Number.isFinite(p))) continue;
      if ([idx(g.cols, r, c), idx(g.cols, r, c + 1), idx(g.cols, r + 1, c), idx(g.cols, r + 1, c + 1)].some(
        (i) => g.blocked[i],
      )) {
        continue;
      }
      // 顺时针回路
      const sum = wrap(p01 - p00) + wrap(p11 - p01) + wrap(p10 - p11) + wrap(p00 - p10);
      const charge = sum > Math.PI ? 1 : sum < -Math.PI ? -1 : 0;
      if (charge !== 0) {
        residues.push({
          cellR: r,
          cellC: c,
          charge: charge as 1 | -1,
          wrapSumRad: Number(sum.toFixed(9)),
          quality: (g.qual[idx(g.cols, r, c)] + g.qual[idx(g.cols, r + 1, c + 1)]) / 2,
        });
        if (charge > 0) positiveCount++;
        else negativeCount++;
      }
    }
  }
  const body = {
    coordinateBasis: x.wrapped.coordinateBasis,
    residues,
    positiveCount,
    negativeCount,
  };
  return finalize('residue_charge_map', 'rcm', body, x, [
    ref(x.wrapped),
    ref(x.amplitude),
    ref(x.quality),
    ref(x.invalid),
  ], createdAt) as ResidueChargeMap;
}

// ---------------------------------------------------------------------------
// 2. 支路切口网络：异号残差最近邻配对 + 人工切口编辑
// ---------------------------------------------------------------------------

export function computeBranchCuts(
  x: EngineInputs,
  residues: ResidueChargeMap,
  createdAt: string,
): BranchCutNetwork {
  const edges: CutEdge[] = [];
  const seen = new Set<string>();
  const addEdge = (e: Omit<CutEdge, 'edgeId'> & { edgeId?: string }) => {
    const id = e.edgeId ?? stableId('cutedge', { o: e.orientation, r: e.r, c: e.c });
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ ...e, edgeId: id });
  };

  const positives = residues.residues.filter((p) => p.charge === 1).map((p) => ({ ...p, used: false }));
  const negatives = residues.residues.filter((p) => p.charge === -1).map((p) => ({ ...p, used: false }));
  const borderTerminations: { r: number; c: number }[] = [];

  for (const pos of positives) {
    if (pos.used) continue;
    let best: (typeof negatives)[number] | null = null;
    let bestDist = Infinity;
    for (const neg of negatives) {
      if (neg.used) continue;
      const d = Math.abs(pos.cellR - neg.cellR) + Math.abs(pos.cellC - neg.cellC);
      if (d < bestDist) {
        bestDist = d;
        best = neg;
      }
    }
    if (best && bestDist <= x.params.maxDipoleDistance) {
      pos.used = true;
      best.used = true;
      connectResidues(pos.cellR, pos.cellC, best.cellR, best.cellC, addEdge, 'dipole');
    } else {
      // 无法配对 → 连到最近边界（产生多连通区/孔洞效应）
      borderTerminations.push({ r: pos.cellR, c: pos.cellC });
      connectToBorder(pos.cellR, pos.cellC, residues.coordinateBasis.rows, residues.coordinateBasis.cols, addEdge);
    }
  }
  for (const neg of negatives) {
    if (!neg.used) {
      borderTerminations.push({ r: neg.cellR, c: neg.cellC });
      connectToBorder(neg.cellR, neg.cellC, residues.coordinateBasis.rows, residues.coordinateBasis.cols, addEdge);
    }
  }

  // 人工切口编辑历史：在算法切口之上叠加（removed 优先）
  const removedSet = new Set<string>();
  for (const batch of x.cutHistory) {
    for (const id of batch.removed) removedSet.add(id);
    for (const e of batch.added) addEdge({ ...e, origin: 'manual' });
  }
  const finalEdges = edges.filter((e) => !removedSet.has(e.edgeId));

  const body = {
    coordinateBasis: x.wrapped.coordinateBasis,
    edges: finalEdges,
    borderTerminations,
  };
  return finalize('branch_cut_network', 'bcn', body, x, [ref(residues)], createdAt) as BranchCutNetwork;
}

type EdgeAdder = (e: Omit<CutEdge, 'edgeId'> & { edgeId?: string }) => void;

function connectResidues(
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  add: EdgeAdder,
  reason: string,
): void {
  let r = r1;
  let c = c1;
  // L 形路径：先水平再垂直，边坐标取下/右像素
  while (c !== c2) {
    const cc = c < c2 ? c : c - 1;
    add({ orientation: 'horizontal', r, c: cc, origin: 'algorithm', integerOffset: null, reason });
    c += c < c2 ? 1 : -1;
  }
  while (r !== r2) {
    const rr = r < r2 ? r : r - 1;
    add({ orientation: 'vertical', r: rr, c, origin: 'algorithm', integerOffset: null, reason });
    r += r < r2 ? 1 : -1;
  }
}

function connectToBorder(r: number, c: number, rows: number, cols: number, add: EdgeAdder): void {
  void rows;
  let rr = r;
  while (rr >= 0) {
    add({ orientation: 'vertical', r: rr, c, origin: 'algorithm', integerOffset: null, reason: 'unpaired-to-border' });
    rr--;
  }
}

// ---------------------------------------------------------------------------
// 3. 展开树（森林）：切口/孔洞阻断，逐连通分量 BFS；不同树各自局部一致
// ---------------------------------------------------------------------------

export function computeUnwrapTrees(
  x: EngineInputs,
  cuts: BranchCutNetwork,
  createdAt: string,
): UnwrapTree[] {
  const g = buildGrid(x);
  const { rows, cols } = g;
  const cutSet = new Set(cuts.edges.map((e) => `${e.orientation[0]}:${e.r}:${e.c}`));
  const isBlockedPixel = (i: number): boolean => x.invalid.invalid[i] || g.blocked[i];

  const edgeBlocked = (r: number, c: number, orientation: 'horizontal' | 'vertical'): boolean => {
    if (cutSet.has(`${orientation[0]}:${r}:${c}`)) return true;
    const a = idx(cols, r, c);
    const b = orientation === 'horizontal' ? idx(cols, r, c + 1) : idx(cols, r + 1, c);
    return g.blocked[a] || g.blocked[b];
  };

  const visited = new Uint8Array(rows * cols);
  const trees: UnwrapTree[] = [];
  let componentIndex = 0;

  // 按质量降序选根：每棵树从其分量内最高质量像素开始
  const order = [...Array(rows * cols).keys()]
    .filter((i) => !isBlockedPixel(i) && Number.isFinite(g.phase[i]))
    .sort((a, b) => g.qual[b] - g.qual[a]);

  for (const start of order) {
    if (visited[start]) continue;
    const sr = Math.floor(start / cols);
    const sc = start % cols;
    const edges: TreeEdge[] = [];
    const queue: number[] = [start];
    visited[start] = 1;
    let covered = 0;

    while (queue.length) {
      const cur = queue.shift()!;
      const r = Math.floor(cur / cols);
      const c = cur % cols;
      covered++;
      const neighbors: [number, number, 'horizontal' | 'vertical'][] = [
        [r, c - 1, 'horizontal'],
        [r, c + 1, 'horizontal'],
        [r - 1, c, 'vertical'],
        [r + 1, c, 'vertical'],
      ];
      for (const [nr, nc, ori] of neighbors) {
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = idx(cols, nr, nc);
        if (visited[ni] || g.blocked[ni] || !Number.isFinite(g.phase[ni])) continue;
        const edgeR = ori === 'horizontal' ? r : Math.min(r, nr);
        const edgeC = ori === 'horizontal' ? Math.min(c, nc) : c;
        if (edgeBlocked(edgeR, edgeC, ori)) continue;
        const wrappedDelta = wrap(g.phase[ni] - g.phase[cur]);
        edges.push({
          edgeId: stableId('tedge', { tree: componentIndex, r: edgeR, c: edgeC, ori }),
          orientation: ori,
          r: edgeR,
          c: edgeC,
          k: 0,
          wrappedDeltaRad: Number(wrappedDelta.toFixed(9)),
          crossesCut: cutSet.has(`${ori[0]}:${edgeR}:${edgeC}`),
          blocked: false,
        });
        visited[ni] = 1;
        queue.push(ni);
      }
    }

    const treeId = `tree-${componentIndex}`;
    const body = {
      treeId,
      root: { r: sr, c: sc },
      edges,
      coveredPixels: covered,
      uncoveredPixels: [] as { r: number; c: number; reason: string }[],
    };
    trees.push(
      finalize('unwrap_tree', `tree_${componentIndex}`, body, x, [], createdAt, { treeId }) as UnwrapTree,
    );
    componentIndex++;
  }

  return trees;
}

/** 所有被阻断/未覆盖像素（低振幅孔洞等）—— 供解层标记 unknown。 */
export function uncoveredPixels(x: EngineInputs): { r: number; c: number; reason: string }[] {
  const g = buildGrid(x);
  const out: { r: number; c: number; reason: string }[] = [];
  for (let i = 0; i < g.rows * g.cols; i++) {
    if (g.blocked[i] || !Number.isFinite(g.phase[i])) {
      out.push({
        r: Math.floor(i / g.cols),
        c: i % g.cols,
        reason: g.blocked[i] ? g.blockReason[i] : 'non-finite-source-phase',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. 循环残差：对每个 2x2 回路（可跨切口）计算整周残差
// ---------------------------------------------------------------------------

export function computeCycleResiduals(
  x: EngineInputs,
  cuts: BranchCutNetwork,
  trees: UnwrapTree[],
  createdAt: string,
): CycleResidualSet {
  const g = buildGrid(x);
  const { rows, cols } = g;
  const treeEdgeSet = new Set<string>();
  for (const t of trees) for (const e of t.edges) treeEdgeSet.add(`${e.orientation[0]}:${e.r}:${e.c}`);
  const cutSet = new Set(cuts.edges.map((e) => `${e.orientation[0]}:${e.r}:${e.c}`));

  const cycles: CycleResidual[] = [];
  let maxAbs = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const corners = [idx(cols, r, c), idx(cols, r, c + 1), idx(cols, r + 1, c + 1), idx(cols, r + 1, c)];
      if (corners.some((i) => !Number.isFinite(g.phase[i]) || g.blocked[i])) continue;
      const p00 = g.phase[corners[0]];
      const p01 = g.phase[corners[1]];
      const p11 = g.phase[corners[2]];
      const p10 = g.phase[corners[3]];
      const dTop = wrap(p01 - p00);
      const dRight = wrap(p11 - p01);
      const dBottom = wrap(p10 - p11);
      const dLeft = wrap(p00 - p10);
      const sum = dTop + dRight + dBottom + dLeft;
      const residualCycles = Math.round(sum / TWO_PI);
      const closed = residualCycles === 0;
      const edgeRefs = [
        `tedge?h:${r}:${c}`,
        `tedge?v:${r}:${c + 1}`,
        `tedge?h:${r + 1}:${c}`,
        `tedge?v:${r}:${c}`,
      ];
      void edgeRefs;
      void treeEdgeSet;
      const crossesBranchCut =
        cutSet.has(`h:${r}:${c}`) ||
        cutSet.has(`v:${r}:${c + 1}`) ||
        cutSet.has(`h:${r + 1}:${c}`) ||
        cutSet.has(`v:${r}:${c}`);
      if (!closed || crossesBranchCut) {
        const cycle: CycleResidual = {
          cycleId: stableId('cyc', { r, c }),
          path: [
            { r, c },
            { r, c: c + 1 },
            { r: r + 1, c: c + 1 },
            { r: r + 1, c },
          ],
          edges: [`h:${r}:${c}`, `v:${r}:${c + 1}`, `h:${r + 1}:${c}`, `v:${r}:${c}`],
          wrappedSumRad: Number(sum.toFixed(9)),
          residualCycles,
          closed,
          crossesBranchCut,
          note: closed ? '回路闭合但跨越支路切口' : `循环不闭合：整周残差 ${residualCycles}`,
        };
        cycles.push(cycle);
        maxAbs = Math.max(maxAbs, Math.abs(residualCycles));
      }
    }
  }
  const body = { cycles, maxAbsResidualCycles: maxAbs };
  return finalize('cycle_residual_set', 'crs', body, x, trees.map(ref).concat([ref(cuts)]), createdAt) as CycleResidualSet;
}

// ---------------------------------------------------------------------------
// 5. 整周候选：对切口两侧 / 多棵树之间的边界像素枚举全部合法 k
//    无法唯一决定时保留全部合法候选；拒绝原因也作为一等数据。
// ---------------------------------------------------------------------------

export function computeIntegerCandidates(
  x: EngineInputs,
  cuts: BranchCutNetwork,
  trees: UnwrapTree[],
  cycles: CycleResidualSet,
  createdAt: string,
): IntegerCandidateSet {
  const g = buildGrid(x);
  const candidates: IntegerCandidate[] = [];

  // 每棵树分配一个基准整周（相对 tree-0）。树间被孔洞/切口隔开，
  // 枚举其相对平移 k ∈ [-1, 0, 1]，由跨切口邻居与循环残差判定合法性。
  for (let t = 1; t < trees.length; t++) {
    const tree = trees[t];
    const rootI = idx(g.cols, tree.root.r, tree.root.c);
    if (!Number.isFinite(g.phase[rootI])) continue;
    const relatedCycles = cycles.cycles
      .filter((cy) => cy.path.some((p) => Math.abs(p.r - tree.root.r) + Math.abs(p.c - tree.root.c) <= 2))
      .map((cy) => cy.cycleId);
    for (const k of [-1, 0, 1]) {
      const legal = k === 0 || relatedCycles.length > 0 || cuts.edges.length > 0;
      candidates.push({
        candidateId: stableId('cand', { tree: tree.treeId, k }),
        pixel: { ...tree.root },
        k,
        legal,
        rejectReason: legal
          ? undefined
          : '该相对整周无跨切口/循环证据支持（没有不闭合路径可吸收此整周）',
        score: legal ? 1 - Math.abs(k) * 0.25 : 0,
        sourceCycleIds: relatedCycles,
      });
    }
  }

  // 切口两侧的显式整周偏移：枚举每条切口边相邻像素的候选 k ∈ {-1,0,1}
  for (const e of cuts.edges) {
    const related = cycles.cycles.filter((cy) => cy.edges.includes(`${e.orientation[0]}:${e.r}:${e.c}`));
    for (const k of [-1, 0, 1]) {
      // 残差非零的回路要求至少一条边吸收整周：k=0 在存在非零残差时被拒绝
      const hasOpenCycle = related.some((cy) => !cy.closed);
      const legal = !hasOpenCycle || k !== 0;
      candidates.push({
        candidateId: stableId('cand', { edge: e.edgeId, k }),
        pixel: { r: e.r, c: e.c },
        k,
        legal,
        rejectReason: legal
          ? undefined
          : '存在非零循环残差，切口边的整周偏移不能为 0',
        score: legal ? (Math.abs(k) === 1 ? 0.9 : 0.5) : 0,
        sourceCycleIds: related.map((cy) => cy.cycleId),
      });
    }
  }

  const ambiguity = candidates.filter((c) => c.legal).length > trees.length - 1 + cuts.edges.length;
  const body = { candidates, ambiguity };
  return finalize(
    'integer_candidate_set',
    'ics',
    body,
    x,
    [ref(cuts), ...trees.map(ref), ref(cycles)],
    createdAt,
  ) as IntegerCandidateSet;
}

// ---------------------------------------------------------------------------
// 6. 展开解：按树 BFS 累积相位；被阻断像素 unknown（绝不猜）；
//    acceptedKByTree/Edge 由人工裁定（锁定候选）提供，无裁定的非基准树保留其局部解
//    且其根整数仍为多解状态。
// ---------------------------------------------------------------------------

export interface AcceptedIntegers {
  /** treeId -> 选中的相对整周 k（人工锁定）；未锁定保持局部基准 0 但标记多解 */
  treeK?: Record<string, number>;
  /** cut edgeId -> 选中整周 k */
  cutK?: Record<string, number>;
  acceptedCandidateByPixel?: Record<string, string>; // "r:c" -> candidateId
}

export function computeSolution(
  x: EngineInputs,
  cuts: BranchCutNetwork,
  trees: UnwrapTree[],
  cycles: CycleResidualSet,
  candidateSet: IntegerCandidateSet,
  accepted: AcceptedIntegers,
  createdAt: string,
): UnwrappedSolution {
  const g = buildGrid(x);
  const { rows, cols } = g;
  const n = rows * cols;
  const phaseRad: (number | null)[] = new Array(n).fill(null);
  const unknownReason: (string | null)[] = new Array(n).fill(null);
  const integerOffset: (number | null)[] = new Array(n).fill(null);
  const acceptedCandidateId: (string | null)[] = new Array(n).fill(null);

  const cutSet = new Set(cuts.edges.map((e) => `${e.orientation[0]}:${e.r}:${e.c}`));
  void cutSet;

  // 每棵树内 BFS 累积包裹差（局部一致）；树整体平移用人工锁定的 treeK，默认 0。
  trees.forEach((tree, ti) => {
    const treeK = accepted.treeK?.[tree.treeId] ?? 0;
    const startI = idx(cols, tree.root.r, tree.root.c);
    if (g.blocked[startI] || !Number.isFinite(g.phase[startI])) return;
    const parent = new Map<number, number>();
    const q = [startI];
    const seen = new Set<number>([startI]);
    parent.set(startI, startI);
    while (q.length) {
      const cur = q.shift()!;
      const r = Math.floor(cur / cols);
      const c = cur % cols;
      for (const [dr, dc, ori] of [
        [0, 1, 'horizontal'],
        [0, -1, 'horizontal'],
        [1, 0, 'vertical'],
        [-1, 0, 'vertical'],
      ] as const) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = idx(cols, nr, nc);
        if (seen.has(ni) || g.blocked[ni] || !Number.isFinite(g.phase[ni])) continue;
        const edgeR = ori === 'horizontal' ? r : Math.min(r, nr);
        const edgeC = ori === 'horizontal' ? Math.min(c, nc) : c;
        if (cutSet.has(`${ori[0]}:${edgeR}:${edgeC}`)) continue;
        parent.set(ni, cur);
        seen.add(ni);
        q.push(ni);
      }
    }
    // 累积
    const base = g.phase[startI] + treeK * TWO_PI;
    for (const pi of seen) {
      // 沿 parent 链求和（网格小，直接回溯）
      let total = 0;
      let cur = pi;
      const chain: number[] = [];
      while (cur !== startI) {
        chain.push(cur);
        cur = parent.get(cur)!;
      }
      for (let j = chain.length - 1; j >= 0; j--) {
        const child = chain[j];
        const par = parent.get(child)!;
        total += wrap(g.phase[child] - g.phase[par]);
      }
      const i = pi;
      phaseRad[i] = Number((base + total).toFixed(9));
      integerOffset[i] = treeK + Math.round((phaseRad[i]! - g.phase[i]) / TWO_PI);
      const key = `${Math.floor(i / cols)}:${i % cols}`;
      acceptedCandidateId[i] = accepted.acceptedCandidateByPixel?.[key] ?? null;
    }
    void ti;
  });

  // 低振幅孔洞/遮罩/非有限：显式未知，绝不猜
  const holes = uncoveredPixels(x);
  for (const h of holes) {
    const i = idx(cols, h.r, h.c);
    phaseRad[i] = null;
    unknownReason[i] = h.reason;
    integerOffset[i] = null;
  }

  // 存在未被锁定的多棵树 / 多解 → 未知原因标注
  if (trees.length > 1) {
    for (const tree of trees.slice(1)) {
      if (accepted.treeK?.[tree.treeId] === undefined) {
        const i = idx(cols, tree.root.r, tree.root.c);
        unknownReason[i] = 'integer-ambiguity：不同展开树间存在多个合法整周候选，尚未锁定';
      }
    }
  }

  const body = {
    coordinateBasis: x.wrapped.coordinateBasis,
    treeRefs: trees.map(ref),
    phaseRad,
    unknownReason,
    integerOffset,
    acceptedCandidateId,
  };
  void cycles;
  void candidateSet;
  return finalize(
    'unwrapped_solution',
    'sol',
    body,
    x,
    [ref(cuts), ...trees.map(ref), ref(cycles), ref(candidateSet)],
    createdAt,
  ) as UnwrappedSolution;
}

// ---------------------------------------------------------------------------
// 7. 高度转换链：phase → 光程差 → 表面高度 → 扣除标定面。
//    每步保留公式/来源/参数指纹；相位未知处高度未知。
// ---------------------------------------------------------------------------

export function computeHeight(
  x: EngineInputs,
  wavelength: Wavelength,
  geometry: IlluminationGeometry,
  calibration: CalibrationSurface,
  solution: UnwrappedSolution,
  createdAt: string,
): HeightField {
  const { rows, cols } = x.wrapped.coordinateBasis;
  const lambdaSi = wavelength.wavelength.siValue;
  const thetaSi = geometry.incidenceAngle.siValue;
  const height: (number | null)[] = new Array(rows * cols).fill(null);
  const unknownReason: (string | null)[] = new Array(rows * cols).fill(null);

  let factor: number | null = null;
  let factorDiag: string | null = null;
  if (lambdaSi === undefined || thetaSi === undefined) {
    factorDiag = '波长或入射角无法规范化到 SI，高度保留未知（原始单位值留在输入层）';
  } else {
    // 单照明敏感因子：dz = phi * lambda / (2π (1 + cos θ))
    factor = lambdaSi / (TWO_PI * (1 + Math.cos(thetaSi)));
  }

  const planeSi =
    calibration.model === 'plane-affine' && calibration.plane
      ? {
          a: calibration.plane.a.siValue,
          b: calibration.plane.b.siValue,
          c: calibration.plane.c.siValue,
        }
      : null;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(cols, r, c);
      const phi = solution.phaseRad[i];
      if (phi === null || factor === null) {
        unknownReason[i] =
          solution.unknownReason[i] ?? factorDiag ?? '相位未知，高度不猜测';
        continue;
      }
      let z = phi * factor;
      if (calibration.model === 'plane-affine' && planeSi && planeSi.a !== undefined && planeSi.b !== undefined && planeSi.c !== undefined) {
        z -= planeSi.a * c + planeSi.b * r + planeSi.c;
      } else if (calibration.model === 'height-grid' && calibration.grid) {
        z -= calibration.grid[i];
      }
      height[i] = Number(z.toFixed(12));
    }
  }

  const chain: HeightChainStep[] = [
    {
      stepId: 'chain-1-unwrapped-phase',
      operation: '读取连续相位',
      formula: 'phi_unwrapped(r,c)',
      inputs: [ref(solution)],
      parameterFingerprint: solution.parameterFingerprint ?? '',
    },
    {
      stepId: 'chain-2-sensitivity-factor',
      operation: '计算高度敏感因子',
      formula: 'K = lambda / (2*pi*(1+cos(theta)))',
      inputs: [ref(wavelength), ref(geometry)],
      parameterFingerprint: parameterFingerprint(ENGINE_VERSION, x.params),
    },
    {
      stepId: 'chain-3-calibration-subtract',
      operation: '扣除标定面',
      formula: calibration.model === 'plane-affine' ? 'h = phi*K - (a*c + b*r + c0)' : 'h = phi*K - calib_grid(r,c)',
      inputs: [ref(calibration)],
      parameterFingerprint: calibration.parameterFingerprint ?? '',
    },
  ];

  const body = {
    coordinateBasis: x.wrapped.coordinateBasis,
    heightUnit: 'meter',
    height,
    unknownReason,
    chain,
  };
  return finalize(
    'height_field',
    'hgt',
    body,
    x,
    [ref(solution), ref(wavelength), ref(geometry), ref(calibration)],
    createdAt,
  ) as HeightField;
}

// ---------------------------------------------------------------------------
// 记录构造：派生值带算法版本、参数指纹、直接来源与内容摘要
// ---------------------------------------------------------------------------

function ref(r: { kind: SourceRef['kind']; entityId: string; versionId: string; contentHash: string }): SourceRef {
  return { kind: r.kind, entityId: r.entityId, versionId: r.versionId, contentHash: r.contentHash };
}

function finalize(
  kind: SourceRef['kind'],
  prefix: string,
  body: Record<string, unknown>,
  x: EngineInputs,
  sources: SourceRef[],
  createdAt: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const fullBody = { ...body, ...extra };
  return {
    kind,
    ...fullBody,
    entityId: stableId(prefix, { ...fullBody, sources }),
    versionId: stableId('ver', { kind, body: fullBody, sources, algo: ENGINE_VERSION }),
    parentVersionId: null,
    contentHash: contentHash({ kind, ...fullBody }),
    algorithmVersion: ENGINE_VERSION,
    parameterFingerprint: parameterFingerprint(ENGINE_VERSION, x.params),
    sources,
    status: 'current',
    createdAt,
  };
}
