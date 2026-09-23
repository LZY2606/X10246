import { edgeId, neighbors4, wrapRad, wrappedDelta } from "./grid";
import type {
  BranchCutNetwork,
  CycleResidual,
  IntegerCandidate,
  InvalidMask,
  RegionMap,
  UnwrapTree,
  UnwrappedPhase,
  WrappedPhaseFrame
} from "../shared/types";

export interface LockClaim {
  lockId: string;
  scope: "pixel" | "edge" | "region";
  targetId: string;
  k: number;
  pixel?: number;
  regionId?: string;
}

interface RankedEdge {
  a: number;
  b: number;
  w: number;
  delta: number;
}

/**
 * 每个连通区构建最大权重生成树（权重=两端质量积，固定 tie-break），
 * 并显式保留路径。低振幅像素的边权重为 0，但只要相位有效仍可被树纳入；
 * 孔洞/遮拦与切口边被排除。
 */
export function buildTrees(
  rows: number,
  cols: number,
  regionMap: RegionMap,
  phase: WrappedPhaseFrame,
  quality: (number | null)[]
): UnwrapTree[] {
  const trees: UnwrapTree[] = [];
  for (const region of regionMap.regions) {
    const set = new Set(region.pixels);
    const edges: RankedEdge[] = [];
    for (const p of region.pixels) {
      for (const nb of neighbors4(p, rows, cols)) {
        if (!set.has(nb) || nb <= p) continue;
        const delta = wrappedDelta(phase.phaseRad, p, nb);
        if (delta === null) continue;
        const w = (quality[p] ?? 0) * (quality[nb] ?? 0);
        edges.push({ a: p, b: nb, w, delta });
      }
    }
    edges.sort((e1, e2) => e2.w - e1.w || e1.a - e2.a || e1.b - e2.b);

    const parent = new Int32Array(region.pixels.length).fill(-1);
    const parentWrappedDelta = new Array<number>(region.pixels.length).fill(0);
    const edgeWeight = new Array<number>(region.pixels.length).fill(0);
    const localIndex = new Map<number, number>();
    region.pixels.forEach((p, li) => localIndex.set(p, li));
    const dsu = new Int32Array(region.pixels.length);
    for (let i = 0; i < dsu.length; i++) dsu[i] = i;
    const find = (x: number): number => {
      while (dsu[x] !== x) {
        dsu[x] = dsu[dsu[x]];
        x = dsu[x];
      }
      return x;
    };

    for (const e of edges) {
      const ia = localIndex.get(e.a)!;
      const ib = localIndex.get(e.b)!;
      const ra = find(ia);
      const rb = find(ib);
      if (ra === rb) continue;
      dsu[ra] = rb;
      parent[ib] = ia;
      parentWrappedDelta[ib] = e.delta;
      edgeWeight[ib] = e.w;
    }

    const root = region.pixels[0]!;
    trees.push({
      regionId: region.regionId,
      root,
      parent: Array.from(parent),
      parentWrappedDelta,
      edgeWeight
    });
  }
  return trees;
}

/**
 * 循环残差：逐个 2x2 闭合回路（小循环）求缠绕梯度之和；
 * 残差无法归约到 0 即 closes=false（循环不闭合）。
 * 另对每条生成树外的质量边计算一次“弦”残差作为路径诊断。
 */
export function computeCycleResiduals(
  rows: number,
  cols: number,
  phase: WrappedPhaseFrame,
  regionMap: RegionMap,
  mask: InvalidMask,
  trees: UnwrapTree[]
): CycleResidual[] {
  const out: CycleResidual[] = [];
  const phaseRad = phase.phaseRad;
  let seq = 0;

  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const p0 = r * cols + c;
      const p1 = p0 + 1;
      const p2 = p0 + cols + 1;
      const p3 = p0 + cols;
      if ([p0, p1, p2, p3].some((p) => mask.invalid[p] || phaseRad[p] === null || phaseRad[p] === undefined)) continue;
      const d01 = wrappedDelta(phaseRad, p0, p1)!;
      const d12 = wrappedDelta(phaseRad, p1, p2)!;
      const d23 = wrappedDelta(phaseRad, p2, p3)!;
      const d30 = wrappedDelta(phaseRad, p3, p0)!;
      const sum = wrapRad(d01 + d12 + d23 + d30);
      const nearest = Math.round(sum / (2 * Math.PI)) * 2 * Math.PI;
      const closes = Math.abs(sum) < 1e-9;
      out.push({
        cycleId: `C${seq++}`,
        edges: [edgeId(p0, p1), edgeId(p1, p2), edgeId(p2, p3), edgeId(p3, p0)],
        pixels: [p0, p1, p2, p3],
        residualRad: sum,
        nearest2PiMultiple: nearest,
        closes,
        reason: closes ? "2x2 回路缠绕和为 0" : "回路包含残差点，缠绕和为 ±2π"
      });
    }
  }

  const byRegion = new Map(trees.map((t) => [t.regionId, t]));
  for (const region of regionMap.regions) {
    const tree = byRegion.get(region.regionId);
    if (!tree) continue;
    const localIndex = new Map<number, number>();
    region.pixels.forEach((p, li) => localIndex.set(p, li));
    const depth = new Int32Array(region.pixels.length);
    for (const p of region.pixels) {
      let li = localIndex.get(p)!;
      let d = 0;
      while (tree.parent[li] !== -1) {
        li = tree.parent[li]!;
        d++;
      }
      depth[localIndex.get(p)!] = d;
    }
    const chordSet = new Set<string>();
    for (const p of region.pixels) {
      for (const nb of neighbors4(p, rows, cols)) {
        if (nb <= p) continue;
        const ia = localIndex.get(p);
        const ib = localIndex.get(nb);
        if (ia === undefined || ib === undefined) continue;
        if (tree.parent[ib] === ia || tree.parent[ia] === ib) continue;
        const key = edgeId(p, nb);
        if (chordSet.has(key)) continue;
        chordSet.add(key);
        const delta = wrappedDelta(phaseRad, p, nb);
        if (delta === null) continue;
        const along = treePathDelta(tree, ia, ib);
        const residual = wrapRad(delta - along);
        const closes = Math.abs(residual) < 1e-9;
        out.push({
          cycleId: `C${seq++}`,
          edges: [key],
          pixels: [p, nb],
          residualRad: residual,
          nearest2PiMultiple: Math.round(residual / (2 * Math.PI)) * 2 * Math.PI,
          closes,
          reason: closes
            ? "生成树弦残差为 0，树路径与直接边一致"
            : "生成树弦残差非零：树路径绕行残差/切口导致局部不一致"
        });
      }
    }
  }
  return out;
}

/** 沿生成树从 ia 到 ib 的缠绕相位差之和 */
function treePathDelta(tree: UnwrapTree, ia: number, ib: number): number {
  const pathA: number[] = [];
  const pathB: number[] = [];
  let a = ia;
  let b = ib;
  const ancA = new Map<number, number>(); // node -> steps
  let steps = 0;
  while (a !== -1) {
    ancA.set(a, steps++);
    pathA.push(a);
    a = tree.parent[a]!;
  }
  steps = 0;
  let lca = -1;
  while (b !== -1) {
    if (ancA.has(b)) {
      lca = b;
      break;
    }
    pathB.push(b);
    steps++;
    b = tree.parent[b]!;
  }
  let sum = 0;
  for (const node of pathA) {
    if (node === lca) break;
    sum += tree.parentWrappedDelta[node]!;
  }
  for (const node of pathB) {
    if (node === lca) break;
    sum -= tree.parentWrappedDelta[node]!;
  }
  return sum;
}

export interface CandidateResult {
  candidates: IntegerCandidate[];
}

/**
 * 整周候选（显式一等数据）：
 * - 普通有效边：唯一 k=0（wrapped delta 已表达最近 2π 邻域）。
 * - 切口两侧：禁止穿越，仍显式给出整周偏移候选 k=-1,0,1（多解），
 *   每个拒绝候选携带原因；无法唯一决定时保留全部合法候选。
 * - 低振幅孔洞相邻边：标记 unknown，不猜测，kValues 为空。
 */
export function computeCandidates(
  rows: number,
  cols: number,
  phase: WrappedPhaseFrame,
  mask: InvalidMask,
  cuts: BranchCutNetwork,
  regionMap: RegionMap,
  quality: (number | null)[],
  lowAmplitudeThreshold: number
): CandidateResult {
  const cutSet = new Set(cuts.cuts.map((c) => c.edgeId));
  const candidates: IntegerCandidate[] = [];
  let seq = 0;
  const regionOf = new Map<number, string>();
  for (const r of regionMap.regions) for (const p of r.pixels) regionOf.set(p, r.regionId);

  for (let p = 0; p < rows * cols; p++) {
    if (mask.invalid[p]) continue;
    for (const nb of neighbors4(p, rows, cols)) {
      if (nb <= p) continue;
      const key = edgeId(p, nb);
      const eitherInvalid = mask.invalid[nb];
      const lowP = quality[p] === null || quality[p]! < lowAmplitudeThreshold;
      const lowN = quality[nb] === null || quality[nb]! < lowAmplitudeThreshold;

      if (eitherInvalid) {
        candidates.push({
          candidateId: `K${seq++}`,
          edgeId: key,
          endpoints: [p, nb],
          kValues: [],
          rejected: [{ k: 0, reason: "邻接无效遮罩孔洞：低振幅/无效区域不得猜相位" }],
          ambiguity: "multiple",
          uncertaintyRad: null,
          note: "masked"
        });
        continue;
      }

      const delta = wrappedDelta(phase.phaseRad, p, nb);
      if (delta === null) continue;

      if (cutSet.has(key)) {
        const legal: number[] = [];
        const rejected: { k: number; reason: string }[] = [];
        for (const k of [-2, -1, 0, 1, 2]) {
          const residual = Math.abs(wrapRad(delta + 2 * Math.PI * k));
          if (residual <= 1e-9) legal.push(k);
          else rejected.push({ k, reason: `φ_b-φ_a+2πk 不能归约到 0（残差 ${residual.toFixed(3)} rad）` });
        }
        const expanded = legal.length ? legal : [-1, 0, 1];
        candidates.push({
          candidateId: `K${seq++}`,
          edgeId: key,
          endpoints: [p, nb],
          kValues: expanded,
          rejected,
          ambiguity: expanded.length > 1 ? "multiple" : "unique",
          uncertaintyRad: null,
          note: "branch_cut：切口两侧整周偏移显式表示，禁止隐式穿越"
        });
        continue;
      }

      if (lowP || lowN) {
        candidates.push({
          candidateId: `K${seq++}`,
          edgeId: key,
          endpoints: [p, nb],
          kValues: [],
          rejected: [{ k: 0, reason: "至少一端位于低振幅区域：质量不足，不得猜相位" }],
          ambiguity: "multiple",
          uncertaintyRad: null,
          note: "low_amplitude"
        });
        continue;
      }

      candidates.push({
        candidateId: `K${seq++}`,
        edgeId: key,
        endpoints: [p, nb],
        kValues: [0],
        rejected: [],
        ambiguity: "unique",
        uncertaintyRad: Math.abs(delta),
        note: regionOf.get(p) === regionOf.get(nb) ? "intra_region" : "inter_region"
      });
    }
  }
  return { candidates };
}

/**
 * 展开相位：区内沿生成树累积包裹差，整周数 n 显式保存。
 * 每棵树根像素 n=0；孔洞/未决定像素为 null，绝不填猜值。
 * 有效锁（pixel/region，未撤销、无冲突）施加额外整周偏移。
 */
export function integrateTrees(
  rows: number,
  cols: number,
  phase: WrappedPhaseFrame,
  regionMap: RegionMap,
  trees: UnwrapTree[],
  activeLocks: LockClaim[]
): UnwrappedPhase {
  const n = rows * cols;
  const phaseOut: (number | null)[] = new Array(n).fill(null);
  const cycles: (number | null)[] = new Array(n).fill(null);
  const referencePixel = regionMap.regions[0]?.pixels[0] ?? 0;

  for (const tree of trees) {
    const region = regionMap.regions.find((r) => r.regionId === tree.regionId)!;
    const localIndex = new Map<number, number>();
    region.pixels.forEach((p, li) => localIndex.set(p, li));

    const regionLocks = activeLocks
      .filter((l) => (l.scope === "region" && l.regionId === tree.regionId) || (l.scope === "pixel" && localIndex.has(l.pixel!)))
      .sort((a, b) => a.lockId.localeCompare(b.lockId));
    let regionOffset = 0;
    const pixelLock = new Map<number, number>();
    for (const l of regionLocks) {
      if (l.scope === "region") regionOffset += l.k;
      else pixelLock.set(l.pixel!, l.k);
    }

    for (const p of region.pixels) {
      const li = localIndex.get(p)!;
      let node = li;
      let deltaSum = 0;
      const chain: number[] = [];
      while (tree.parent[node] !== -1) {
        deltaSum += tree.parentWrappedDelta[node]!;
        chain.push(node);
        node = tree.parent[node]!;
      }
      const wrap = phase.phaseRad[p]!;
      const baseUnwrap = wrap + deltaSum;
      const nCycles = Math.round((baseUnwrap - wrap) / (2 * Math.PI));
      const lockAdd = pixelLock.get(p) ?? 0;
      const totalCycles = nCycles + regionOffset + lockAdd;
      cycles[p] = totalCycles;
      phaseOut[p] = wrap + 2 * Math.PI * totalCycles;
    }
  }
  return {
    kind: "unwrapped_phase",
    rows,
    cols,
    phaseRad: phaseOut,
    integerCycles: cycles,
    referencePixel,
    trees
  };
}
