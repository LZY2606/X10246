import { TWO_PI, wrapCountForDelta, wrapToPi } from "./units";
import { fnv1a32 } from "./hash";
import type {
  CycleResidual,
  Grid2D,
  IntegerCandidate,
  PhaseEdge,
  PixelId,
  ResiduePlaquette,
  UnwrapTreeResult,
  VersionEntity,
} from "./types";

export const ENGINE_ALGORITHM_VERSION = "unwrap.bct/1.3.0";
export const HEIGHT_ALGORITHM_VERSION = "height.fringe/1.1.0";

export interface UnwrapParams {
  /** 振幅低于该阈值（归一化 0..1）即视为低质量，不猜相位。 */
  amplitudeThreshold: number;
  /** 信噪评分低于该值视为无效。 */
  snrThreshold: number;
  /** 生成的不同展开树数量上限。 */
  maxTrees: number;
  tieBreakSeed: number;
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  amplitudeThreshold: 0.25,
  snrThreshold: 0.3,
  maxTrees: 3,
  tieBreakSeed: 7,
};

export interface GridInputs {
  phase: Grid2D;
  amplitude: Grid2D;
  snr: Grid2D;
  invalid: Grid2D;
  phaseVersionId: string;
  amplitudeVersionId: string;
  snrVersionId: string;
  maskVersionId: string;
}

const pid = (r: number, c: number): PixelId => ({ r, c });
export const pixelKey = (p: PixelId) => `${p.r}:${p.c}`;
const edgeIdOf = (a: PixelId, b: PixelId) =>
  `e_${fnv1a32(`${pixelKey(a)}|${pixelKey(b)}`).slice(0, 12)}`;

/** 像素是否可信：不在无效遮罩内、振幅与信噪比足够。 */
export function isReliable(inp: GridInputs, params: UnwrapParams, r: number, c: number): boolean {
  const idx = r * inp.phase.cols + c;
  if (inp.invalid.data[idx] >= 0.5) return false;
  if (!(inp.amplitude.data[idx] >= params.amplitudeThreshold)) return false;
  if (!(inp.snr.data[idx] >= params.snrThreshold)) return false;
  return true;
}

export interface EdgeRecord {
  edgeId: string;
  a: PixelId;
  b: PixelId;
  horizontal: boolean;
  wrappedDelta: number;
  principalWrapCount: number;
  cutExtra: number;
  reliable: boolean;
  confidence: number;
}

/** 建立右、下方向的全部边；低振幅/遮罩端点的边标记为不可靠(unknown)。 */
export function buildEdges(inp: GridInputs, params: UnwrapParams): EdgeRecord[] {
  const { rows, cols } = inp.phase;
  const edges: EdgeRecord[] = [];
  const push = (r1: number, c1: number, r2: number, c2: number, horizontal: boolean) => {
    const i1 = r1 * cols + c1;
    const i2 = r2 * cols + c2;
    const d = wrapToPi(inp.phase.data[i2] - inp.phase.data[i1]);
    const reliable =
      isReliable(inp, params, r1, c1) && isReliable(inp, params, r2, c2);
    const conf = Math.min(inp.amplitude.data[i1], inp.amplitude.data[i2]) *
      Math.min(inp.snr.data[i1], inp.snr.data[i2]);
    edges.push({
      edgeId: edgeIdOf(pid(r1, c1), pid(r2, c2)),
      a: pid(r1, c1),
      b: pid(r2, c2),
      horizontal,
      wrappedDelta: d,
      principalWrapCount: wrapCountForDelta(d),
      cutExtra: 0,
      reliable,
      confidence: reliable ? conf : 0,
    });
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols) push(r, c, r, c + 1, true);
      if (r + 1 < rows) push(r, c, r + 1, c, false);
    }
  }
  return edges;
}

/** 2x2 残差点（电荷）：四条右边/下边的主值包裹差之和 / 2π。 */
export function detectResidues(inp: GridInputs, edges: EdgeRecord[]): ResiduePlaquette[] {
  const { rows, cols } = inp.phase;
  const map = new Map<string, EdgeRecord>();
  for (const e of edges) map.set(e.edgeId, e);
  const find = (r1: number, c1: number, r2: number, c2: number) =>
    map.get(edgeIdOf(pid(r1, c1), pid(r2, c2)))!;
  const out: ResiduePlaquette[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const top = find(r, c, r, c + 1);
      const right = find(r, c + 1, r + 1, c + 1);
      const bottom = find(r + 1, c, r + 1, c + 1);
      const left = find(r, c, r + 1, c);
      const sum =
        top.wrappedDelta + right.wrappedDelta - bottom.wrappedDelta - left.wrappedDelta;
      const charge = Math.round(sum / TWO_PI);
      if (charge !== 0) {
        out.push({
          plaquetteId: `p_${r}_${c}`,
          tl: pid(r, c),
          charge: charge > 0 ? 1 : -1,
          wrappedSum: sum,
        });
      }
    }
  }
  return out;
}

/** 支路切口：连接无法配对残差点的可靠边被标为切口（显式整周偏移）。 */
export function assignBranchCuts(
  edges: EdgeRecord[],
  residues: ResiduePlaquette[],
  seed: number
): EdgeRecord[] {
  const next = edges.map((e) => ({ ...e, cutExtra: 0 }));
  const emap = new Map(next.map((e) => [e.edgeId, e]));
  const incident = (r: number, c: number) =>
    [
      c + 1 < Infinity ? edgeIdOf(pid(r, c), pid(r, c + 1)) : "",
      r + 1 < Infinity ? edgeIdOf(pid(r, c), pid(r + 1, c)) : "",
      c - 1 >= 0 ? edgeIdOf(pid(r, c - 1), pid(r, c)) : "",
      r - 1 >= 0 ? edgeIdOf(pid(r - 1, c), pid(r, c)) : "",
    ].filter((id) => emap.has(id));

  const used = new Set<string>();
  // 最近邻、按确定性顺序配对异号残差点；连线上的边成为切口，显式携带 ±1 整周。
  const positives = residues.filter((p) => p.charge > 0);
  const negatives = residues.filter((p) => p.charge < 0);
  let s = seed >>> 0;
  const jitter = () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0;
    return s / 4294967296;
  };
  for (const pos of positives) {
    let best: ResiduePlaquette | null = null;
    let bestD = Infinity;
    for (const neg of negatives) {
      if (used.has(neg.plaquetteId)) continue;
      const d =
        Math.abs(pos.tl.r - neg.tl.r) + Math.abs(pos.tl.c - neg.tl.c) + jitter() * 1e-6;
      if (d < bestD) {
        bestD = d;
        best = neg;
      }
    }
    if (best) {
      used.add(best.plaquetteId);
      const pathIds = cutLineEdges(next, pos.tl, best.tl);
      for (const id of pathIds) {
        const e = emap.get(id)!;
        if (!e.reliable) continue;
        e.cutExtra += pos.charge;
      }
    } else {
      // 无法配对 → 通向边界的“枝”：显式整周偏移留在边界侧。
      const start = incident(pos.tl.r, pos.tl.c).sort()[0];
      const e = emap.get(start);
      if (e && e.reliable) e.cutExtra += pos.charge;
    }
  }
  // 未被配对的负残差同样落到边界。
  for (const neg of negatives) {
    if (used.has(neg.plaquetteId)) continue;
    const start = incident(neg.tl.r, neg.tl.c).sort()[0];
    const e = emap.get(start);
    if (e && e.reliable) e.cutExtra += neg.charge;
  }
  return next;
}

function cutLineEdges(edges: EdgeRecord[], a: PixelId, b: PixelId): string[] {
  const have = new Set(edges.map((e) => e.edgeId));
  const ids: string[] = [];
  let r = a.r;
  let c = a.c;
  while (c !== b.c) {
    const nc = c + Math.sign(b.c - c);
    const id = edgeIdOf(pid(r, c), pid(r, nc));
    if (have.has(id)) ids.push(id);
    c = nc;
  }
  while (r !== b.r) {
    const nr = r + Math.sign(b.r - r);
    const id = edgeIdOf(pid(r, c), pid(nr, c));
    if (have.has(id)) ids.push(id);
    r = nr;
  }
  return ids;
}

interface Graph {
  adj: Map<string, { to: string; edgeId: string; edge: EdgeRecord }[]>;
  nodes: Set<string>;
}

function buildGraph(edges: EdgeRecord[]): Graph {
  const adj = new Map<string, { to: string; edgeId: string; edge: EdgeRecord }[]>();
  const nodes = new Set<string>();
  const key = (p: PixelId) => pixelKey(p);
  for (const e of edges) {
    if (!e.reliable) continue;
    const a = key(e.a);
    const b = key(e.b);
    nodes.add(a);
    nodes.add(b);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push({ to: b, edgeId: e.edgeId, edge: e });
    adj.get(b)!.push({ to: a, edgeId: e.edgeId, edge: e });
  }
  return { adj, nodes };
}

/**
 * 随机化 Prim/Kruskal 风格生成多棵不同的展开树（确定性 seed）。
 * 不同展开树可对同一数据给出局部一致解；我们保留每棵树的路径与循环残差。
 */
function spanningTrees(graph: Graph, count: number, seed: number): string[][] {
  const trees: string[][] = [];
  const seen = new Set<string>();
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6d2b79f5) >>> 0;
    return s / 4294967296;
  };
  const components = connectedComponents(graph);
  for (let t = 0; t < count; t++) {
    const treeEdges: string[] = [];
    for (const comp of components) {
      const inComp = new Set(comp);
      const visited = new Set<string>();
      const start = comp[Math.floor(rnd() * comp.length)];
      visited.add(start);
      while (visited.size < inComp.size) {
        const frontier: { from: string; edgeId: string; to: string; w: number }[] = [];
        for (const node of visited) {
          for (const nb of graph.adj.get(node) ?? []) {
            if (!inComp.has(nb.to) || visited.has(nb.to)) continue;
            frontier.push({
              from: node,
              edgeId: nb.edgeId,
              to: nb.to,
              w: nb.edge.confidence + rnd() * 1e-9,
            });
          }
        }
        if (frontier.length === 0) break;
        frontier.sort((x, y) => y.w - x.w || (x.edgeId < y.edgeId ? -1 : 1));
        const pick = frontier[t % frontier.length < 1 ? 0 : t % frontier.length];
        visited.add(pick.to);
        treeEdges.push(pick.edgeId);
      }
    }
    const sig = treeEdges.slice().sort().join(",");
    if (!seen.has(sig)) {
      seen.add(sig);
      trees.push(treeEdges);
    }
  }
  // 保底至少一棵树。
  if (trees.length === 0 && graph.nodes.size > 0) {
    const fallback: string[] = [];
    const visited = new Set<string>();
    for (const node of graph.nodes) {
      if (visited.has(node)) continue;
      visited.add(node);
      const queue = [node];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const nb of graph.adj.get(cur) ?? []) {
          if (visited.has(nb.to)) continue;
          visited.add(nb.to);
          fallback.push(nb.edgeId);
          queue.push(nb.to);
        }
      }
    }
    trees.push(fallback);
  }
  return trees;
}

function connectedComponents(graph: Graph): string[][] {
  const comps: string[][] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (seen.has(node)) continue;
    const comp: string[] = [];
    const queue = [node];
    seen.add(node);
    while (queue.length) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const nb of graph.adj.get(cur) ?? []) {
        if (!seen.has(nb.to)) {
          seen.add(nb.to);
          queue.push(nb.to);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

interface TreeModel {
  treeId: string;
  treeEdgeSet: Set<string>;
  /** 节点 -> 相对整周层 N（根=0）。 */
  nodeWrap: Map<string, number>;
  components: number;
}

function integrateTree(graph: Graph, treeEdges: string[], edges: EdgeRecord[], index: number): TreeModel {
  const treeSet = new Set(treeEdges);
  const edgeById = new Map(edges.map((e) => [e.edgeId, e]));
  const nodeWrap = new Map<string, number>();
  let components = 0;
  for (const root of graph.nodes) {
    if (nodeWrap.has(root)) continue;
    components += 1;
    nodeWrap.set(root, 0);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of graph.adj.get(cur) ?? []) {
        if (!treeSet.has(nb.edgeId) || nodeWrap.has(nb.to)) continue;
        const e = edgeById.get(nb.edgeId)!;
        const k = e.principalWrapCount + e.cutExtra;
        const forward = pixelKey(e.a) === cur;
        nodeWrap.set(nb.to, nodeWrap.get(cur)! + (forward ? k : -k));
        queue.push(nb.to);
      }
    }
  }
  return {
    treeId: `tree_${String(index + 1).padStart(2, "0")}`,
    treeEdgeSet: treeSet,
    nodeWrap,
    components,
  };
}

/** 对每一条非树边（弦）计算其形成的基本循环的整周残差。 */
function cycleResidualsFor(
  graph: Graph,
  tree: TreeModel,
  edges: EdgeRecord[],
  treeEdges: string[]
): CycleResidual[] {
  const edgeById = new Map(edges.map((e) => [e.edgeId, e]));
  const parent = new Map<string, { from: string; edgeId: string }>();
  const roots = new Set<string>();
  for (const root of graph.nodes) {
    if (parent.has(root)) continue;
    roots.add(root);
    parent.set(root, { from: root, edgeId: "" });
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of graph.adj.get(cur) ?? []) {
        if (!tree.treeEdgeSet.has(nb.edgeId) || parent.has(nb.to)) continue;
        parent.set(nb.to, { from: cur, edgeId: nb.edgeId });
        queue.push(nb.to);
      }
    }
  }
  const residuals: CycleResidual[] = [];
  const treeSet = new Set(treeEdges);
  const seen = new Set<string>();
  for (const e of edges) {
    if (!e.reliable) continue;
    if (treeSet.has(e.edgeId)) continue;
    const ka = pixelKey(e.a);
    const kb = pixelKey(e.b);
    if (!tree.nodeWrap.has(ka) || !tree.nodeWrap.has(kb)) continue;
    const sig = [e.edgeId, ka, kb].sort().join("|");
    if (seen.has(sig)) continue;
    seen.add(sig);
    // 树上 a->b 路径
    const pathUp: string[] = [];
    const pathDown: string[] = [];
    const ancA: string[] = [];
    const ancB: string[] = [];
    let x = ka;
    while (true) {
      ancA.push(x);
      const p = parent.get(x);
      if (!p || p.from === x) break;
      pathUp.push(p.edgeId);
      x = p.from;
    }
    let y = kb;
    while (true) {
      ancB.push(y);
      const p = parent.get(y);
      if (!p || p.from === y) break;
      pathDown.unshift(p.edgeId);
      y = p.from;
    }
    const setA = new Set(ancA);
    const lca = ancB.find((n) => setA.has(n));
    let trimmedUp = pathUp;
    if (lca) {
      let cur = ka;
      trimmedUp = [];
      while (cur !== lca) {
        const p = parent.get(cur)!;
        trimmedUp.push(p.edgeId);
        cur = p.from;
      }
    }
    let trimmedDown = pathDown;
    if (lca) {
      let cur = kb;
      const rev: string[] = [];
      while (cur !== lca) {
        const p = parent.get(cur)!;
        rev.push(p.edgeId);
        cur = p.from;
      }
      trimmedDown = rev.reverse();
    }
    const treeIntegral = tree.nodeWrap.get(kb)! - tree.nodeWrap.get(ka)!;
    const chordK = e.principalWrapCount + e.cutExtra;
    const residual = chordK - treeIntegral;
    const path = [...trimmedUp, e.edgeId, ...trimmedDown];
    residuals.push({
      cycleId: `cyc_${fnv1a32(tree.treeId + "|" + e.edgeId).slice(0, 10)}`,
      path,
      residualTurns: residual,
      closed: residual === 0,
      status: residual === 0 ? "closed" : "non_closed",
      sourceTreeId: tree.treeId,
    });
  }
  return residuals;
}

/** 生成整周候选：切边显式给出多解（cutExtra 与 cutExtra±1 均合法时保留全部）。 */
function candidatesForTree(edges: EdgeRecord[], tree: TreeModel): IntegerCandidate[] {
  const out: IntegerCandidate[] = [];
  for (const e of edges) {
    if (!e.reliable) continue;
    const base = e.principalWrapCount + e.cutExtra;
    if (e.cutExtra !== 0) {
      const values = [e.cutExtra - 1, e.cutExtra, e.cutExtra + 1].map((extra) =>
        e.principalWrapCount + extra
      );
      out.push({
        candidateId: `cand_${fnv1a32(tree.treeId + "|" + e.edgeId).slice(0, 10)}`,
        edgeId: e.edgeId,
        wrapCountValues: values,
        legal: true,
        ambiguityGroup: `branchcut_${tree.treeId}`,
      });
    } else if (!tree.treeEdgeSet.has(e.edgeId)) {
      // 弦边：主值候选是 base，若导致循环不闭合则同时记录拒绝原因。
      out.push({
        candidateId: `cand_${fnv1a32(tree.treeId + "|" + e.edgeId).slice(0, 10)}`,
        edgeId: e.edgeId,
        wrapCountValues: [base],
        legal: true,
        ambiguityGroup: `chord_${tree.treeId}`,
      });
    }
  }
  return out;
}

function buildPhaseEdges(edges: EdgeRecord[], tree: TreeModel): PhaseEdge[] {
  return edges.map((e) => {
    if (!e.reliable) {
      return {
        edgeId: e.edgeId,
        a: e.a,
        b: e.b,
        wrappedDelta: e.wrappedDelta,
        wrapCount: 0,
        isCut: false,
        unknown: true,
        confidence: 0,
      };
    }
    return {
      edgeId: e.edgeId,
      a: e.a,
      b: e.b,
      wrappedDelta: e.wrappedDelta,
      wrapCount: e.principalWrapCount + e.cutExtra,
      isCut: e.cutExtra !== 0,
      unknown: false,
      confidence: e.confidence,
    };
  });
}

function unwrapGrid(inp: GridInputs, tree: TreeModel): { grid: Grid2D; unresolved: PixelId[] } {
  const { rows, cols } = inp.phase;
  const data = new Array<number>(rows * cols).fill(NaN);
  const unresolved: PixelId[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = pixelKey(pid(r, c));
      const idx = r * cols + c;
      const n = tree.nodeWrap.get(key);
      if (n === undefined) {
        unresolved.push(pid(r, c));
      } else {
        data[idx] = inp.phase.data[idx] + TWO_PI * n;
      }
    }
  }
  return {
    grid: { rows, cols, data, unit: "rad", coordinateFrame: inp.phase.coordinateFrame },
    unresolved,
  };
}

export interface UnwrapOutput {
  results: UnwrapTreeResult[];
  residues: ResiduePlaquette[];
  edges: EdgeRecord[];
}

export function runUnwrap(
  inp: GridInputs,
  params: UnwrapParams,
  createdAtEventId: string
): UnwrapOutput {
  const rawEdges = buildEdges(inp, params);
  const residues = detectResidues(inp, rawEdges);
  const edges = assignBranchCuts(rawEdges, residues, params.tieBreakSeed);
  const graph = buildGraph(edges);
  const treeEdgeLists = spanningTrees(graph, params.maxTrees, params.tieBreakSeed);

  const results: UnwrapTreeResult[] = treeEdgeLists.map((treeEdges, i) => {
    const tree = integrateTree(graph, treeEdges, edges, i);
    const { grid, unresolved } = unwrapGrid(inp, tree);
    const cycleResiduals = cycleResidualsFor(graph, tree, edges, treeEdges);
    const candidates = candidatesForTree(edges, tree);
    const resultId =
      `unwrap_${fnv1a32(
        [
          inp.phaseVersionId,
          inp.amplitudeVersionId,
          inp.snrVersionId,
          inp.maskVersionId,
          ENGINE_ALGORITHM_VERSION,
          JSON.stringify(params),
          tree.treeId,
        ].join("|")
      ).slice(0, 12)}`;
    return {
      resultId,
      treeId: tree.treeId,
      algorithmVersion: ENGINE_ALGORITHM_VERSION,
      paramsFingerprint: fingerprintParams(params),
      directSources: [
        inp.phaseVersionId,
        inp.amplitudeVersionId,
        inp.snrVersionId,
        inp.maskVersionId,
      ],
      grid,
      edges: buildPhaseEdges(edges, tree),
      plaquettes: residues,
      candidates,
      cycleResiduals,
      unresolvedPixels: unresolved,
      status: "current",
      createdAtEventId,
    };
  });

  return { results, residues, edges };
}

export function fingerprintParams(params: unknown): string {
  return "fp_" + fnv1a32(JSON.stringify(params)).slice(0, 12);
}
