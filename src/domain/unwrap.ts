/**
 * 二维相位展开核心：
 *  - 质量引导最大生成树（确定性、带固定 seed 的平局打破）；
 *  - 像元方块残差 -> 支路切口；切口两侧整周偏移显式枚举候选；
 *  - 基本循环残差（闭合/不闭合显式保留）；
 *  - 低振幅/遮罩像素永不猜相位（保持 null）；
 *  - 多连通分量各自局部一致，跨分量偏移保留全部合法候选。
 */
import type { RawGrid } from './vocabulary.ts';
import { convertPhaseToRad, convertSnr } from './units.ts';
import { SeededRng } from '../shared/rng.ts';
import { contentHash } from '../shared/ids.ts';
import type {
  AnalysisParams,
  CellQuality,
  Component,
  CycleRef,
  GraphEdge,
  HeightResult,
  HeightStep,
  IntegerCandidate,
  Plaquette,
  QualityField,
  UnwrappedTree,
  UnwrapResult,
} from './analysis-types.ts';
import { DEFAULT_PARAMS } from './analysis-types.ts';

const TWO_PI = 2 * Math.PI;

export function wrappedDiffRad(to: number, from: number): number {
  return ((to - from + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
}

function algRef(name: string, params: unknown): QualityField['algorithm'] {
  return { name, version: 'alg-1.0.0', parameterFingerprint: `fp_${contentHash(params)}` };
}

/** 信噪评分：随包提供则保留原值并在派生层规范化为 dB；否则由振幅/噪声地板派生。 */
export function buildQuality(grid: RawGrid, params: AnalysisParams, seed: number): QualityField {
  const n = grid.rows * grid.cols;
  const snrDb = new Float64Array(n).fill(NaN);
  const quality: CellQuality[] = new Array(n).fill('usable');
  const reasons: (string | null)[] = new Array(n).fill(null);
  const rng = new SeededRng(seed ^ 0x9e3779b9);

  for (let i = 0; i < n; i++) {
    if (grid.invalid[i]) {
      quality[i] = grid.tileOrigin[i] === -1 ? 'uncovered' : 'masked';
      reasons[i] = grid.invalidReason[i];
      continue;
    }
    const amp = grid.amplitude[i] ?? NaN;
    let db: number;
    if (grid.snrProvided && grid.snrUnit) {
      db = convertSnr(grid.snrProvided[i] ?? NaN, grid.snrUnit, 'dB');
    } else {
      db = 20 * Math.log10(Math.max(amp, 1e-9) / params.noiseFloorAdu) - rng.next() * params.snrDecayPerPixel;
    }
    snrDb[i] = db;
    if (!Number.isFinite(amp) || amp < params.lowAmplitudeThresholdAdu) {
      quality[i] = 'low-amplitude';
      reasons[i] = `amplitude ${amp.toFixed(2)} ${grid.amplitudeUnit} < 阈值 ${params.lowAmplitudeThresholdAdu} ADU：不得猜相位`;
    } else if (db < params.qualityRejectSnrDb) {
      quality[i] = 'low-amplitude';
      reasons[i] = `SNR ${db.toFixed(2)} dB < ${params.qualityRejectSnrDb} dB：低可信，不参与展开`;
    }
  }
  return { snrDb, quality, reasons, algorithm: algRef('snr-from-amplitude-v1', { params, unit: grid.amplitudeUnit }) };
}

interface RawPlaquette {
  r: number;
  c: number;
  pixels: [number, number, number, number];
  deltas: [number, number, number, number];
  valid: boolean;
  invalidReason: string | null;
}

function buildPlaquettes(grid: RawGrid, quality: QualityField): { list: Plaquette[]; raw: RawPlaquette[] } {
  const { rows, cols } = grid;
  const radAt = (i: number) => convertPhaseToRad(grid.phase[i] ?? NaN, grid.phaseUnit);
  const usable = (i: number) => !grid.invalid[i] && quality.quality[i] === 'usable';
  const list: Plaquette[] = [];
  const raw: RawPlaquette[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = r * cols + c + 1;
      const d = (r + 1) * cols + c;
      const e = (r + 1) * cols + c + 1;
      const pixels: [number, number, number, number] = [a, b, e, d];
      const allUsable = [a, b, d, e].every((p) => usable(p));
      let invalidReason: string | null = null;
      let deltas: [number, number, number, number] = [0, 0, 0, 0];
      if (allUsable) {
        deltas = [
          wrappedDiffRad(radAt(b), radAt(a)),
          wrappedDiffRad(radAt(e), radAt(b)),
          wrappedDiffRad(radAt(d), radAt(e)),
          wrappedDiffRad(radAt(a), radAt(d)),
        ];
      } else {
        const bad = [a, b, d, e].find((p) => !usable(p));
        invalidReason = `像元 ${bad} 不可用（${quality.quality[bad] ?? 'masked'}）：循环无法闭合评估`;
      }
      const index = r * (cols - 1) + c;
      raw.push({ r, c, pixels, deltas, valid: allUsable, invalidReason });
      const wrappedSumRad = deltas.reduce((s, x) => s + x, 0);
      const residueCycles = Math.round(wrappedSumRad / TWO_PI) as -1 | 0 | 1;
      list.push({
        plaquetteId: `plaq_${r}_${c}`,
        index,
        r,
        c,
        pixels,
        wrappedSumRad,
        residueCycles: allUsable ? residueCycles : 0,
        valid: allUsable,
        invalidReason,
      });
    }
  }
  return { list, raw };
}

interface RawEdge {
  edgeId: string;
  a: number;
  b: number;
  orientation: 'h' | 'v';
  r: number;
  c: number;
  wrappedDeltaRad: number;
  quality: number;
}

function buildEdges(grid: RawGrid, quality: QualityField): RawEdge[] {
  const { rows, cols } = grid;
  const edges: RawEdge[] = [];
  const usable = (i: number) => !grid.invalid[i] && quality.quality[i] === 'usable';
  const radAt = (i: number) => convertPhaseToRad(grid.phase[i] ?? NaN, grid.phaseUnit);
  const q = (i: number) => quality.snrDb[i] ?? -Infinity;
  const push = (a: number, b: number, orientation: 'h' | 'v', r: number, c: number) => {
    if (!usable(a) || !usable(b)) return;
    edges.push({
      edgeId: `edge_${a}_${b}`,
      a,
      b,
      orientation,
      r,
      c,
      wrappedDeltaRad: wrappedDiffRad(radAt(b), radAt(a)),
      quality: Math.min(q(a), q(b)),
    });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) push(i, i + 1, 'h', r, c);
      if (r + 1 < rows) push(i, i + cols, 'v', r, c);
    }
  }
  return edges;
}

/** 确定性最大生成森林：质量降序，同分用固定 seed 洗牌。 */
function maximumSpanningForest(edges: RawEdge[], pixelCount: number, seed: number): { tree: Set<string>; parent: Int32Array; components: Map<number, number[]> } {
  const rng = new SeededRng(seed ^ 0x51ed270b);
  const order = rng.shuffle(edges.map((_, i) => i)).sort((i, j) => (edges[j]!.quality - edges[i]!.quality) || i - j);
  const parent = new Int32Array(pixelCount).fill(-2);
  for (const e of edges) {
    if (parent[e.a] === -2) parent[e.a] = e.a;
    if (parent[e.b] === -2) parent[e.b] = e.b;
  }
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[x] !== x) {
      const nx = parent[x] as number;
      parent[x] = root;
      x = nx;
    }
    return root;
  };
  const tree = new Set<string>();
  for (const i of order) {
    const e = edges[i]!;
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra === rb) continue;
    parent[ra] = rb;
    tree.add(e.edgeId);
  }
  const comps = new Map<number, number[]>();
  for (let p = 0; p < pixelCount; p++) {
    if (parent[p] === -2) continue;
    const root = find(p);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root)!.push(p);
  }
  return { tree, parent, components: comps };
}

interface Adj {
  to: number;
  edgeId: string;
  k: number;
  delta: number;
}

function buildAdjacency(edgeById: Map<string, RawEdge & { treeK: number }>, treeSet: Set<string>, pixelCount: number): Adj[][] {
  const adj: Adj[][] = Array.from({ length: pixelCount }, () => []);
  for (const e of edgeById.values()) {
    if (!treeSet.has(e.edgeId)) continue;
    const d = e.wrappedDeltaRad + TWO_PI * e.treeK;
    adj[e.a]!.push({ to: e.b, edgeId: e.edgeId, k: e.treeK, delta: d });
    adj[e.b]!.push({ to: e.a, edgeId: e.edgeId, k: -e.treeK, delta: -d });
  }
  return adj;
}

function integrateTree(
  start: number,
  componentPixels: number[],
  adj: Adj[][],
): { unwrapped: Map<number, number>; offset: Map<number, number>; parentEdge: Map<number, string>; pathTo: (target: number) => string[] } {
  const unwrapped = new Map<number, number>();
  const offset = new Map<number, number>();
  const parentEdge = new Map<number, string>();
  unwrapped.set(start, 0);
  offset.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const n of adj[cur]!) {
      if (unwrapped.has(n.to)) continue;
      unwrapped.set(n.to, (unwrapped.get(cur) ?? 0) + n.delta);
      offset.set(n.to, (offset.get(cur) ?? 0) + n.k);
      parentEdge.set(n.to, n.edgeId);
      queue.push(n.to);
    }
  }
  const pathTo = (target: number): string[] => {
    const path: string[] = [];
    let cur = target;
    while (cur !== start && parentEdge.has(cur)) {
      const eid = parentEdge.get(cur)!;
      path.push(eid);
      const e = edgeById.get(eid)!;
      cur = e.a === cur ? e.b : e.a;
    }
    return path.reverse();
  };
  void componentPixels;
  return { unwrapped, offset, parentEdge, pathTo };
}

function enumerateCandidates(edge: RawEdge, residualCycles: number, params: AnalysisParams): IntegerCandidate[] {
  const cands: IntegerCandidate[] = [];
  const baseK = residualCycles;
  for (const k of [baseK - 1, baseK, baseK + 1]) {
    const delta = edge.wrappedDeltaRad + TWO_PI * k;
    const cycleResidual = (delta - edge.wrappedDeltaRad) / TWO_PI - residualCycles;
    const plausible = Math.abs(delta) <= params.maxPlausibleJumpRad;
    const nearBranch = Math.abs(Math.abs(edge.wrappedDeltaRad) - Math.PI) < 0.2;
    const fitScore = -(Math.abs(delta) / edge.quality);
    let status: IntegerCandidate['status'] = 'legal';
    let rejectReason: string | null = null;
    if (!plausible) {
      status = 'rejected';
      rejectReason = `|Δunwrapped|=${Math.abs(delta).toFixed(2)} rad 超过可信跳变上限 ${params.maxPlausibleJumpRad.toFixed(2)}`;
    } else if (nearBranch && edge.quality < 28 && Math.abs(k) >= 1) {
      rejectReason = '低质量支路上的大幅整周，需人工确认（保留为 legal 供裁定）';
    }
    cands.push({
      candidateId: `${edge.edgeId}__k${k}`,
      k,
      deltaRad: delta,
      cycleResidualCycles: cycleResidual,
      fitScore,
      status,
      rejectReason,
    });
  }
  return cands;
}

export interface RunUnwrapOptions {
  params?: AnalysisParams;
  seed: number;
}

export function runUnwrap(grid: RawGrid, quality: QualityField, opts: RunUnwrapOptions): UnwrapResult {
  const params = opts.params ?? DEFAULT_PARAMS;
  const n = grid.rows * grid.cols;
  const { list: plaquettes } = buildPlaquettes(grid, quality);
  const rawEdges = buildEdges(grid, quality);
  const { tree: treeSet, components: compMap } = maximumSpanningForest(rawEdges, n, opts.seed);

  const edgeList: (RawEdge & { treeK: number })[] = rawEdges.map((e) => ({ ...e, treeK: 0 }));
  const edgeById = new Map(edgeList.map((e) => [e.edgeId, e]));

  // 分量与锚点
  const components: Component[] = [];
  const pixelComponent = new Map<number, string>();
  let compIdx = 0;
  for (const [, pixels0] of compMap) {
    const pixels = pixels0.slice().sort((x, y) => x - y);
    const componentId = `comp_${compIdx}`;
    const anchorPixel = pixels[0]!;
    for (const p of pixels) pixelComponent.set(p, componentId);
    components.push({ componentId, pixels, anchorPixel, relativeOffsetCandidates: [] });
    compIdx++;
  }

  const adj = buildAdjacency(edgeById, treeSet, n);
  const treeIntegrations = new Map<string, ReturnType<typeof integrateTree>>();
  const trees: UnwrappedTree[] = [];
  const primary = new Array<number | null>(n).fill(null);
  const primaryOffset = new Array<number | null>(n).fill(null);
  const anchorWrapped = new Map<string, number>();
  const radAt = (i: number) => convertPhaseToRad(grid.phase[i] ?? NaN, grid.phaseUnit);

  components.forEach((comp, ci) => {
    const integ = integrateTree(comp.anchorPixel, comp.pixels, adj);
    treeIntegrations.set(comp.componentId, integ);
    const edgesInTree = [...new Set(comp.pixels.flatMap((p) => adj[p]!.map((a) => a.edgeId)))].sort();
    const anchorPhi = radAt(comp.anchorPixel);
    anchorWrapped.set(comp.componentId, anchorPhi);
    for (const p of comp.pixels) {
      const u = integ.unwrapped.get(p);
      if (u === undefined) continue;
      primary[p] = anchorPhi + u;
      primaryOffset[p] = integ.offset.get(p) ?? 0;
    }
    trees.push({
      treeId: `tree_quality_${ci}`,
      role: 'quality-guided',
      componentId: comp.componentId,
      edges: edgesInTree,
      cyclesOffset: primaryOffset.map((o, p) => (pixelComponent.get(p) === comp.componentId ? o : null)),
      unwrappedRad: primary.map((v, p) => (pixelComponent.get(p) === comp.componentId ? v : null)),
      locallyConsistent: true,
      closedCycles: [],
      openCycles: [],
      note: '质量引导最大生成树；树内沿路径积分，全部基本循环按树闭合',
    });
  });

  // 非树边 -> 基本循环（树路径 + 该边），残差 = 像元/循环残差
  const cycles: CycleRef[] = [];
  const edges: GraphEdge[] = [];
  const branchCuts: string[] = [];

  for (const e of edgeList) {
    const isTree = treeSet.has(e.edgeId);
    const ca = pixelComponent.get(e.a);
    const cb = pixelComponent.get(e.b);
    let status: GraphEdge['status'];
    let cycle: CycleRef | null = null;
    let candidates: IntegerCandidate[] = [];
    let rejectedReason: string | null = null;
    let treeK = 0;

    if (isTree) {
      status = 'tree';
    } else if (ca !== cb) {
      status = 'component-gap';
      const ciA = components.findIndex((c) => c.componentId === ca);
      for (const k of [-1, 0, 1]) {
        components[ciA]!.relativeOffsetCandidates.push({
          candidateId: `gap_${e.edgeId}__k${k}`,
          k,
          status: 'legal',
          reason: '跨遮罩分量，相对整周偏移不可直接观测：保留为合法候选，等待人工锁定',
        });
      }
      rejectedReason = '多连通分量间偏移不可观测，保持 UNKNOWN，不猜测';
    } else {
      const integ = treeIntegrations.get(ca!)!;
      const path = integ.pathTo(e.b);
      const anchorPhi = anchorWrapped.get(ca!)!;
      const uB = integ.unwrapped.get(e.b)!;
      const uA = integ.unwrapped.get(e.a)!;
      void anchorPhi;
      // 树路径给出的 a->b 未包裹差
      const treeDelta = uB - uA;
      const residualCycles = Math.round((e.wrappedDeltaRad - treeDelta) / TWO_PI) as -1 | 0 | 1;
      const edgePath = [e.edgeId, ...path];
      const wrappedSum = e.wrappedDeltaRad - treeDelta;
      const closed = residualCycles === 0;
      const cycleId = `cycle_${e.edgeId}`;
      cycle = {
        cycleId,
        edgePath,
        wrappedSumRad: wrappedSum,
        residualCycles: closed ? 0 : (residualCycles as -1 | 1),
        closed,
        note: closed
          ? '基本循环闭合：树路径整周与包裹差一致'
          : `循环不闭合：残差 ${residualCycles} cycle，需要支路切口或整周裁定`,
      };
      cycles.push(cycle);
      candidates = enumerateCandidates(e, residualCycles, params);
      if (!closed) {
        status = 'branch-cut-required';
        branchCuts.push(e.edgeId);
      } else {
        const ambiguous = candidates.filter((c) => c.status === 'legal' && Math.abs(c.deltaRad) <= params.maxPlausibleJumpRad).length >= 2
          ? candidates.filter((c) => c.status === 'legal').length >= 2
          : false;
        status = ambiguous ? 'cut-candidate' : 'discarded';
        if (ambiguous) branchCuts.push(e.edgeId);
      }
    }

    if (isTree) {
      // 树边整周由积分隐式确定：用相邻 offset 差恢复
      const oa = primaryOffset[e.a] ?? 0;
      const ob = primaryOffset[e.b] ?? 0;
      treeK = (ob ?? 0) - (oa ?? 0);
    }

    edges.push({
      edgeId: e.edgeId,
      a: e.a,
      b: e.b,
      orientation: e.orientation,
      r: e.r,
      c: e.c,
      wrappedDeltaRad: e.wrappedDeltaRad,
      quality: e.quality,
      status,
      treeK,
      candidates,
      cycle,
      rejectedReason,
    });
  }

  // 把循环归属写回树
  for (const t of trees) {
    for (const cy of cycles) {
      if (cy.edgePath.some((id) => t.edges.includes(id))) {
        (cy.closed ? t.closedCycles : t.openCycles).push(cy.cycleId);
      }
    }
  }

  // 像元残差非零 -> 残差必须由切口连接到边界/另一个残差（这里记录“支路切口要求”诊断）
  const nonzeroPlaq = plaquettes.filter((p) => p.valid && p.residueCycles !== 0);
  const diagnostics: string[] = [];
  for (const p of nonzeroPlaq) {
    diagnostics.push(
      `像元方块 plaq_${p.r}_${p.c} 残差 ${p.residueCycles} cycle：相邻支路标记 branch-cut-required，切口两侧整周偏移显式枚举`,
    );
  }

  const resultId = `unwrap_${contentHash({
    bundle: grid.bundleId,
    params,
    seed: opts.seed,
    edges: edges.map((x) => `${x.edgeId}:${x.status}`).sort(),
  })}`;

  return {
    resultId,
    plaquettes,
    edges,
    components,
    trees,
    primaryUnwrappedRad: primary,
    cycles,
    branchCuts,
    algorithm: algRef('quality-guided-mst-unwrap-v1', params),
    diagnostics,
  };
}
