import type {
  BranchCutNetworkPayload,
  CycleResidual,
  ResidueMapPayload,
  IntegerCandidate,
  QualityMapPayload,
  UnwrapTree,
  UnwrapTreeEdge,
  UnwrappedForestPayload,
  WrappedPhaseInput
} from './types.js';
import { idx, inBounds, NEIGHBORS, TWO_PI, wrapToPi, wrappedDelta } from './geometry.js';
import { stableEdgeKey } from './residues.js';
import { computeCycleResiduals } from './cycles.js';

export const UNWRAP_ALGO_VERSION = 'unwrap.forest.v4';

export interface UnwrapParams {
  /** 对非树边保留的最大合法整周候选数 */
  maxCandidates: number;
  /** 候选代价超过该值视为非法 */
  candidateCostTolerance: number;
}
export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  maxCandidates: 3,
  candidateCostTolerance: 0.5
};
export function unwrapFingerprint(p: UnwrapParams): string {
  return `cand<=${p.maxCandidates};tol=${p.candidateCostTolerance}`;
}

interface GraphEdge {
  key: string;
  a: [number, number];
  b: [number, number];
  weight: number;
  cut: boolean;
}

/**
 * 二维相位展开：
 * 1) 仅在质量可信像素间建 4-邻接图（低振幅/无效像素不参与 => 孔洞形成多连通区）。
 * 2) 切口边被显式排除出展开树（切口两侧整周偏移显式保留，不猜）。
 * 3) 每个连通域用质量引导的最大生成树；沿树传播整周 k。
 * 4) 非树边给出整周多解候选并计算基本环残差（环不闭合即残差点/切口绕行）。
 * 不同树得到的都是局部一致解，全部保留路径与环残差。
 */
export function computeUnwrappedForest(
  phase: WrappedPhaseInput,
  quality: QualityMapPayload,
  residues: ResidueMapPayload,
  cuts: BranchCutNetworkPayload,
  params: UnwrapParams = DEFAULT_UNWRAP_PARAMS
): UnwrappedForestPayload {
  const { width: w, height: h } = phase;
  const usable = (u: number, v: number) =>
    inBounds(u, v, w, h) && quality.score[idx(u, v, w)] !== null;

  const cutSet = new Set(cuts.edges.map((e) => stableEdgeKey(e.a, e.b)));
  const cutOffset = new Map<string, number | null>();
  for (const e of cuts.edges) cutOffset.set(stableEdgeKey(e.a, e.b), e.integerOffset);

  // 连通域标记（不跨切口、不进入孔洞）
  const component = new Int32Array(w * h).fill(-1);
  const componentIdOf = (u: number, v: number) => component[idx(u, v, w)];
  let componentCount = 0;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      if (!usable(u, v) || component[idx(u, v, w)] !== -1) continue;
      const cid = componentCount++;
      const stack: [number, number][] = [[u, v]];
      component[idx(u, v, w)] = cid;
      while (stack.length) {
        const [cu, cv] = stack.pop()!;
        for (const [du, dv] of NEIGHBORS) {
          const nu = cu + du;
          const nv = cv + dv;
          if (!usable(nu, nv)) continue;
          if (component[idx(nu, nv, w)] !== -1) continue;
          if (cutSet.has(stableEdgeKey([cu, cv], [nu, nv]))) continue;
          component[idx(nu, nv, w)] = cid;
          stack.push([nu, nv]);
        }
      }
    }
  }

  // 收集图边（每对邻接一次），权重=两端平均质量
  const edgesByComponent = new Map<number, GraphEdge[]>();
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      if (!usable(u, v)) continue;
      const cid = componentIdOf(u, v);
      for (const [du, dv] of NEIGHBORS) {
        if (du < 0 || (du === 0 && dv < 0)) continue; // 只取右、下
        const nu = u + du;
        const nv = v + dv;
        if (!usable(nu, nv)) continue;
        if (componentIdOf(nu, nv) !== cid) continue;
        const key = stableEdgeKey([u, v], [nu, nv]);
        const isCut = cutSet.has(key);
        const weight =
          (quality.score[idx(u, v, w)]! + quality.score[idx(nu, nv, w)]!) / 2;
        const list = edgesByComponent.get(cid) ?? [];
        list.push({ key, a: [u, v], b: [nu, nv], weight, cut: isCut });
        edgesByComponent.set(cid, list);
      }
    }
  }

  const trees: UnwrapTree[] = [];
  const treeOf: (string | null)[] = new Array(w * h).fill(null);
  const unwrappedPhase: (number | null)[] = new Array(w * h).fill(null);
  const integerCandidates: Record<string, IntegerCandidate[]> = {};
  const allCycles: CycleResidual[] = [];

  for (let cid = 0; cid < componentCount; cid++) {
    const allEdges = edgesByComponent.get(cid) ?? [];
    const nonCut = allEdges.filter((e) => !e.cut).sort((x, y) => y.weight - x.weight);

    // 收集该域像素
    const pixels: [number, number][] = [];
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++)
        if (componentIdOf(u, v) === cid) pixels.push([u, v]);
    pixels.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    const root = pixels[0];

    // 最大生成树（并查集）
    const parent = new Map<string, string>();
    const keyOf = (p: [number, number]) => `${p[0]},${p[1]}`;
    for (const p of pixels) parent.set(keyOf(p), keyOf(p));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let c = x;
      while (parent.get(c) !== c) {
        const n = parent.get(c)!;
        parent.set(c, r);
        c = n;
      }
      return r;
    };

    const treeEdges: UnwrapTreeEdge[] = [];
    const adj = new Map<string, { to: [number, number]; edge: UnwrapTreeEdge }[]>();
    const addAdj = (from: string, to: [number, number], edge: UnwrapTreeEdge) => {
      const list = adj.get(from) ?? [];
      list.push({ to, edge });
      adj.set(from, list);
    };

    for (const ge of nonCut) {
      const ka = keyOf(ge.a);
      const kb = keyOf(ge.b);
      const { delta, crosses } = wrappedDelta(
        phase.raw[idx(ge.a[0], ge.a[1], w)],
        phase.raw[idx(ge.b[0], ge.b[1], w)]
      );
      if (find(ka) === find(kb)) continue;
      parent.set(find(ka), find(kb));
      const edge: UnwrapTreeEdge = {
        id: `te:${ge.key}`,
        a: ge.a,
        b: ge.b,
        wrappedDelta: delta,
        crossesBranch: crosses,
        k: 0, // 先占位，传播时确定
        cut: false
      };
      treeEdges.push(edge);
      addAdj(ka, ge.b, edge);
      addAdj(kb, ge.a, edge);
    }

    const treeId = `tree:c${cid}`;
    // 沿树传播整周：k[b] = k[a] 当 wrap(delta) 与真实差一致，否则按跨越修正
    const kAt = new Map<string, number>();
    kAt.set(keyOf(root), 0);
    const visited = new Set<string>([keyOf(root)]);
    const queue: [number, number][] = [root];
while (queue.length) {
      const [cu, cv] = queue.shift()!;
      const ck = kAt.get(keyOf([cu, cv]))!;
      for (const { to, edge } of adj.get(keyOf([cu, cv])) ?? []) {
        const tk = keyOf(to);
        if (visited.has(tk)) continue;
        visited.add(tk);
        // 连续差 = 有向包裹差；设 from->to 的原始差为 dRaw，则
        // 整周增量 n = round((wrapped - dRaw)/2π)，使 raw+2πK 连续。
        const forward = edge.a[0] === cu && edge.a[1] === cv;
        const rawA = phase.raw[idx(edge.a[0], edge.a[1], w)];
        const rawB = phase.raw[idx(edge.b[0], edge.b[1], w)];
        const dRaw = forward ? rawB - rawA : rawA - rawB;
        const dWrap = forward ? edge.wrappedDelta : -edge.wrappedDelta;
        const n = Math.round((dWrap - dRaw) / TWO_PI);
        kAt.set(tk, ck + n);
        // edge.k 统一以 a->b 存储
        edge.k = forward ? n : -n;
        queue.push(to);
      }
    }

    // 展开相位
    for (const p of pixels) {
      const k = kAt.get(keyOf(p)) ?? 0;
      unwrappedPhase[idx(p[0], p[1], w)] = phase.raw[idx(p[0], p[1], w)] + k * TWO_PI;
      treeOf[idx(p[0], p[1], w)] = treeId;
    }

    // 非树边：整周多解候选
    const treeEdgeSet = new Set(treeEdges.map((e) => e.id));
    for (const ge of nonCut) {
      const candidateEdgeId = `te:${ge.key}`;
      if (treeEdgeSet.has(candidateEdgeId)) continue;
      const ka = kAt.get(keyOf(ge.a))!;
      const kb = kAt.get(keyOf(ge.b))!;
      const { delta } = wrappedDelta(
        phase.raw[idx(ge.a[0], ge.a[1], w)],
        phase.raw[idx(ge.b[0], ge.b[1], w)]
      );
      // 期望的树传播整周边
      const expected = kb - ka;
      const cands: IntegerCandidate[] = [];
      for (let k = expected - 1; k <= expected + 1; k++) {
        // 残差：delta + 2pi*k 与树路径累计之差
        const residual = delta + k * TWO_PI - (kb - ka) * TWO_PI - delta;
        const cost = Math.abs(k - expected);
        const accepted = k === expected;
        cands.push({
          k,
          cost,
          accepted,
          rejectReason: accepted ? null : explainCandidate(k, expected, residual)
        });
      }
      integerCandidates[candidateEdgeId] = cands.slice(0, params.maxCandidates + 1);
    }

    // 切口边：显式整周偏移未知（除非人工已确认），登记多解占位
    for (const ge of allEdges.filter((e) => e.cut)) {
      const off = cutOffset.get(ge.key) ?? null;
      const edgeId = `cut:${ge.key}`;
      const cands: IntegerCandidate[] = [-1, 0, 1].map((k) => ({
        k,
        cost: Math.abs(k),
        accepted: off === k,
        rejectReason:
          off === k
            ? null
            : off === null
              ? 'cut_offset_unresolved：切口两侧整周偏移未由人工确认，系统不猜'
              : 'superseded_by_manual_offset'
      }));
      integerCandidates[edgeId] = cands;
    }

    const built: UnwrapTree = {
      id: treeId,
      componentId: cid,
      pixels,
      edges: treeEdges,
      root,
      rootInteger: 0
    };
    trees.push(built);

    // 基本环残差
    const cycleResult = computeCycleResiduals(
      cid,
      treeId,
      pixels,
      treeEdges,
      nonCut,
      phase,
      residues.charges,
      w
    );
    for (const c of cycleResult.cycles) allCycles.push(c);
  }

  return {
    kind: 'unwrapped_forest',
    width: w,
    height: h,
    trees,
    treeOf,
    unwrappedPhase,
    cycles: allCycles,
    integerCandidates,
    algorithmVersion: UNWRAP_ALGO_VERSION,
    parameterFingerprint: unwrapFingerprint(params)
  };
}

function explainCandidate(k: number, expected: number, residual: number): string {
  if (k === expected + 1 || k === expected - 1)
    return 'alt_integer_wrap：相邻合法整周解，与当前树路径相差一个整周，需环残差/人工锁定裁决';
  void residual;
  return 'non_minimal_integer：非最小整周候选';
}
