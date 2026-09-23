import { shortHash } from '../../shared/hash';
import type { CutSegment, GridField, MaskGrid } from '../../shared/domain';

export const UNWRAP_ALGORITHM_VERSION = 'unwrap-v1.0.0';
export const TWO_PI = Math.PI * 2;

export function wrapToPi(x: number): number {
  let v = x % TWO_PI;
  if (v > Math.PI) v -= TWO_PI;
  else if (v <= -Math.PI) v += TWO_PI;
  return v;
}

export interface UnwrapParams {
  lowAmplitudeThreshold: number;
  seed: number;
}

export interface IntegerOffset {
  edge: [number, number];
  k: number;
  explicit: true;
}

export interface CycleResidual {
  cycleId: string;
  edge: [number, number];
  residualRad: number;
  residualTurns: number;
  isCut: boolean;
}

export interface UnwrapCandidate {
  candidateId: string;
  component: number;
  tree: 'primary' | 'alternate';
  kShift: number;
  shiftEdge: [number, number] | null;
  path: number[];
  pixels: number[];
  unwrapped: (number | null)[];
  cycleResiduals: CycleResidual[];
}

export interface EngineEvent {
  type: string;
  basis: Record<string, unknown>;
}

export interface UnwrapOutput {
  valid: number[];
  holes: number[];
  components: number[];
  componentCount: number;
  componentPixels: number[][];
  qualityMap: (number | null)[];
  candidates: UnwrapCandidate[];
  integerOffsets: IntegerOffset[];
  cycles: CycleResidual[];
  wrapBoundaryEdges: [number, number][];
  events: EngineEvent[];
}

interface TreeResult {
  root: number;
  parent: Int32Array;
  order: number[];
  phi: Float64Array;
}

export function unwrapField(
  wrapped: GridField,
  quality: GridField,
  mask: MaskGrid,
  cuts: CutSegment[],
  params: UnwrapParams,
): UnwrapOutput {
  const W = wrapped.width;
  const H = wrapped.height;
  const N = W * H;
  const idx = (x: number, y: number) => y * W + x;
  const xy = (i: number): [number, number] => [i % W, Math.floor(i / W)];
  const events: EngineEvent[] = [];

  // 1) 有效性：遮罩外 + 低振幅孔洞。低振幅区域不得猜相位，保留 UNKNOWN。
  const valid = new Array<number>(N).fill(0);
  const holes: number[] = [];
  for (let i = 0; i < N; i++) {
    if (mask.data[i]) continue;
    if (quality.data[i] < params.lowAmplitudeThreshold) {
      holes.push(i);
      continue;
    }
    valid[i] = 1;
  }

  // 质量图：派生层才规范化，原始评分保持不变
  let qMin = Infinity;
  let qMax = -Infinity;
  for (let i = 0; i < N; i++) {
    if (mask.data[i]) continue;
    qMin = Math.min(qMin, quality.data[i]);
    qMax = Math.max(qMax, quality.data[i]);
  }
  const span = qMax - qMin || 1;
  const qualityMap: (number | null)[] = new Array(N).fill(null);
  for (let i = 0; i < N; i++) {
    if (!mask.data[i]) qualityMap[i] = (quality.data[i] - qMin) / span;
  }

  // 2) 多连通区
  const components = new Array<number>(N).fill(-1);
  const componentPixels: number[][] = [];
  const neighborsOf = (i: number): number[] => {
    const [x, y] = xy(i);
    const out: number[] = [];
    if (x + 1 < W) out.push(i + 1);
    if (y + 1 < H) out.push(i + W);
    if (x - 1 >= 0) out.push(i - 1);
    if (y - 1 >= 0) out.push(i - W);
    return out;
  };
  for (let s = 0; s < N; s++) {
    if (!valid[s] || components[s] !== -1) continue;
    const cid = componentPixels.length;
    const pixels: number[] = [];
    const queue = [s];
    components[s] = cid;
    while (queue.length) {
      const u = queue.shift()!;
      pixels.push(u);
      for (const v of neighborsOf(u)) {
        if (valid[v] && components[v] === -1) {
          components[v] = cid;
          queue.push(v);
        }
      }
    }
    pixels.sort((a, b) => a - b);
    componentPixels.push(pixels);
  }

  // 3) 切口网络：切口边不进展开树；跨切口整周偏移显式存放
  const cutEdges = new Map<string, [number, number]>();
  for (const c of cuts) {
    const a = idx(c.ax, c.ay);
    const b = idx(c.bx, c.by);
    if (a < 0 || b < 0 || a >= N || b >= N) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    cutEdges.set(key, a < b ? [a, b] : [b, a]);
  }
  const isCut = (a: number, b: number) =>
    cutEdges.has(a < b ? `${a},${b}` : `${b},${a}`);
  const integerOffsets: IntegerOffset[] = [...cutEdges.values()].map(([a, b]) => ({
    edge: [a, b],
    k: 0,
    explicit: true,
  }));

  const buildTree = (root: number, cid: number, dirOrder: number[]): TreeResult => {
    const parent = new Int32Array(N).fill(-2);
    const order: number[] = [];
    const phi = new Float64Array(N).fill(NaN);
    parent[root] = -1;
    phi[root] = wrapped.data[root];
    const queue = [root];
    while (queue.length) {
      const u = queue.shift()!;
      order.push(u);
      const [x, y] = xy(u);
      for (const d of dirOrder) {
        const nx = x + (d === 0 ? 1 : d === 2 ? -1 : 0);
        const ny = y + (d === 1 ? 1 : d === 3 ? -1 : 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const v = ny * W + nx;
        if (!valid[v] || components[v] !== cid || parent[v] !== -2) continue;
        if (isCut(u, v)) continue;
        parent[v] = u;
        phi[v] = phi[u] + wrapToPi(wrapped.data[v] - wrapped.data[u]);
        queue.push(v);
      }
    }
    return { root, parent, order, phi };
  };

  const computeResiduals = (cid: number, parent: Int32Array, phi: Float64Array): CycleResidual[] => {
    const out: CycleResidual[] = [];
    for (const u of componentPixels[cid]) {
      for (const v of neighborsOf(u)) {
        if (v <= u || components[v] !== cid) continue;
        if (parent[v] === u || parent[u] === v) continue;
        const cut = isCut(u, v);
        const g = wrapToPi(wrapped.data[v] - wrapped.data[u]);
        const residual = phi[v] - phi[u] - g;
        out.push({
          cycleId: `cyc_${u}_${v}`,
          edge: [u, v],
          residualRad: residual,
          residualTurns: Math.round(residual / TWO_PI),
          isCut: cut,
        });
      }
    }
    return out;
  };

  const allCandidates: UnwrapCandidate[] = [];
  const allCycles: CycleResidual[] = [];
  let multiComponents = componentPixels.length > 1;

  for (let cid = 0; cid < componentPixels.length; cid++) {
    const pixels = componentPixels[cid];
    // 根像素：质量最高（固定 tie-break：最小索引），固定 seed 下完全确定
    let root = pixels[0];
    for (const p of pixels) if (quality.data[p] > quality.data[root]) root = p;

    const makeCandidate = (
      tree: 'primary' | 'alternate',
      tr: TreeResult,
      kShift: number,
      shiftEdge: [number, number] | null,
    ): UnwrapCandidate => {
      const shifted = new Float64Array(N).fill(NaN);
      for (const p of pixels) shifted[p] = tr.phi[p];
      if (shiftEdge && kShift !== 0) {
        const deeper = shiftEdge[1];
        // 沿展开树把“更深一侧”整体平移 -2π·m，等价的合法整周解
        for (const p of pixels) {
          let cur = p;
          let onSide = false;
          while (cur !== -1) {
            if (cur === deeper) { onSide = true; break; }
            cur = tr.parent[cur];
          }
          if (onSide) shifted[p] = tr.phi[p] - TWO_PI * kShift;
        }
      }
      const cycles = computeResiduals(cid, tr.parent, shifted);
      const unwrapped: (number | null)[] = new Array(N).fill(null);
      for (const p of pixels) unwrapped[p] = shifted[p];
      const candidateId = `cand_${shortHash({
        cid, tree, root, kShift, shiftEdge, seed: params.seed,
      })}`;
      return {
        candidateId,
        component: cid,
        tree,
        kShift,
        shiftEdge,
        path: tr.order.slice(),
        pixels: pixels.slice(),
        unwrapped,
        cycleResiduals: cycles,
      };
    };

    const primary = buildTree(root, cid, [0, 1, 2, 3]);
    const primaryCand = makeCandidate('primary', primary, 0, null);
    allCandidates.push(primaryCand);
    allCycles.push(...primaryCand.cycleResiduals);

    // 循环不闭合：残差为整周数 m≠0
    const nonClosed = primaryCand.cycleResiduals.filter((r) => r.residualTurns !== 0);

    // 整周多解：每个非闭合循环给出另一个合法候选（切口一侧整周平移）
    for (const r of nonClosed) {
      const alt = makeCandidate('primary', primary, r.residualTurns, [r.edge[0], r.edge[1]]);
      if (!allCandidates.some((c) => c.candidateId === alt.candidateId)) {
        allCandidates.push(alt);
        allCycles.push(...alt.cycleResiduals);
      }
    }

    // 不同展开树：反向遍历得到局部一致解，保留各自路径与循环残差
    const altRoot = pixels[0];
    if (altRoot !== root || pixels.length > 1) {
      const alternate = buildTree(altRoot, cid, [3, 2, 1, 0]);
      const altCand = makeCandidate('alternate', alternate, 0, null);
      if (!allCandidates.some((c) => c.candidateId === altCand.candidateId)) {
        allCandidates.push(altCand);
        allCycles.push(...altCand.cycleResiduals);
      }
    }
  }

  // 4) 相位跨越边界：相邻有效像素包裹差 > π
  const wrapBoundaryEdges: [number, number][] = [];
  let touchesBorder = false;
  for (let i = 0; i < N; i++) {
    if (!valid[i]) continue;
    for (const j of [i + 1, i + W]) {
      if (j >= N) continue;
      if (j === i + 1 && i % W === W - 1) continue;
      if (!valid[j]) continue;
      if (Math.abs(wrapped.data[j] - wrapped.data[i]) > Math.PI) {
        wrapBoundaryEdges.push([i, j]);
        const [xi, yi] = [i % W, Math.floor(i / W)];
        const [xj, yj] = [j % W, Math.floor(j / W)];
        if ([xi, yi, xj, yj].some((v, k) =>
          (k % 2 === 0 ? v === 0 || v === W - 1 : v === 0 || v === H - 1))) {
          touchesBorder = true;
        }
      }
    }
  }

  // 5) 机器可读取判断事件
  if (holes.length) {
    events.push({
      type: 'LOW_AMPLITUDE_NO_GUESS',
      basis: {
        rule: 'low-amplitude-region-must-not-guess-phase',
        threshold: params.lowAmplitudeThreshold,
        pixels: holes,
        consequence: 'unwrapped-phase-null-no-interpolation',
      },
    });
  }
  if (multiComponents) {
    events.push({
      type: 'MULTI_COMPONENT_REGION',
      basis: {
        rule: 'multi-connected-region-keeps-relative-integer-unknown',
        componentCount: componentPixels.length,
        sizes: componentPixels.map((p) => p.length),
      },
    });
  }
  if (cutEdges.size) {
    events.push({
      type: 'CUT_OFFSET_EXPLICIT',
      basis: {
        rule: 'integer-offset-across-cut-must-be-explicit',
        offsets: integerOffsets,
      },
    });
  }
  if (wrapBoundaryEdges.length) {
    events.push({
      type: 'PHASE_CROSSING_BOUNDARY',
      basis: {
        rule: 'wrapped-jump-exceeds-pi',
        count: wrapBoundaryEdges.length,
        edges: wrapBoundaryEdges.slice(0, 64),
        touchesFieldBorder: touchesBorder,
      },
    });
  }
  const nonZero = allCycles.filter((c) => c.residualTurns !== 0);
  if (nonZero.length) {
    events.push({
      type: 'CYCLE_NONCLOSURE',
      basis: {
        rule: 'cycle-residual-is-nonzero-integer-turns',
        cycles: nonZero.map((c) => ({
          cycleId: c.cycleId,
          edge: c.edge,
          residualTurns: c.residualTurns,
          residualRad: c.residualRad,
        })),
      },
    });
  }
  if (allCandidates.length > componentPixels.length) {
    events.push({
      type: 'INTEGER_AMBIGUITY',
      basis: {
        rule: 'keep-all-legal-integer-candidates-when-not-unique',
        candidates: allCandidates.map((c) => ({
          candidateId: c.candidateId,
          component: c.component,
          tree: c.tree,
          kShift: c.kShift,
          shiftEdge: c.shiftEdge,
        })),
      },
    });
  }

  // 多树局部一致性：同分量内 primary / alternate 相差恰好整周常数
  for (let cid = 0; cid < componentPixels.length; cid++) {
    const cs = allCandidates.filter((c) => c.component === cid);
    const primary = cs.find((c) => c.tree === 'primary' && c.kShift === 0);
    const alternate = cs.find((c) => c.tree === 'alternate' && c.kShift === 0);
    if (primary && alternate) {
      const diffs: number[] = [];
      for (const p of primary.pixels) {
        const d = (primary.unwrapped[p] as number) - (alternate.unwrapped[p] as number);
        diffs.push(Math.round(d / TWO_PI));
      }
      const consistent = diffs.every((d) => d === diffs[0]);
      events.push({
        type: 'MULTI_TREE_LOCAL_CONSISTENCY',
        basis: {
          rule: 'different-unwrapping-trees-keep-path-and-cycle-residuals',
          component: cid,
          consistent,
          constantIntegerDifference: consistent ? diffs[0] : null,
          pathPrimary: primary.path,
          pathAlternate: alternate.path,
          residualsPrimary: primary.cycleResiduals,
          residualsAlternate: alternate.cycleResiduals,
        },
      });
    }
  }

  return {
    valid,
    holes,
    components,
    componentCount: componentPixels.length,
    componentPixels,
    qualityMap,
    candidates: allCandidates,
    integerOffsets,
    cycles: allCycles,
    wrapBoundaryEdges,
    events,
  };
}

export function paramFingerprint(
  algorithmVersion: string,
  params: Record<string, unknown>,
): string {
  return shortHash({ algorithmVersion, params });
}
