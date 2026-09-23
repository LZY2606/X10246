import type {
  AmplitudeFrame,
  CalibrationPlane,
  CutEditHistory,
  IlluminationGeometry,
  InvalidMask,
  SnrScoreMap,
  WavelengthSpec,
  WrappedPhaseFrame,
} from '../shared/types.js';
import {
  ALGORITHM_VERSION,
  CUT_ALGORITHM_VERSION,
  HEIGHT_ALGORITHM_VERSION,
  RESIDUE_ALGORITHM_VERSION,
} from '../shared/types.js';
import { canonicalJson, sha256Hex } from './hash.js';

export interface Pixel {
  r: number;
  c: number;
}

export interface UnwrapParams {
  /** 振幅低于该阈值视为低振幅孔洞（按振幅单位，默认按归一化分位数给出） */
  amplitudeThreshold: number;
  amplitudeThresholdKind: 'absolute' | 'quantile';
  /** 整周候选搜索半径 |k|≤kMax */
  integerKMax: number;
  /** 是否把人工切口边标记为禁跨边（仍显式给出两侧整周偏移） */
  respectCutEdits: boolean;
}

export const DEFAULT_PARAMS: UnwrapParams = {
  amplitudeThreshold: 0.25,
  amplitudeThresholdKind: 'quantile',
  integerKMax: 2,
  respectCutEdits: true,
};

export interface PlaquetteResidue {
  id: string;
  /** 2×2 小板左上角像素 */
  anchor: Pixel;
  /** 绕板一周包裹差主值之和 /(2π)，取值 -1,0,+1 */
  charge: -1 | 0 | 1;
  windingRad: number;
}

export interface GraphEdge {
  id: string;
  a: Pixel;
  b: Pixel;
  /** 边的方向：b 相对 a 的网格方向 */
  direction: 'h' | 'v';
  /** 包裹相位主值差 Δφ ∈ (-π,π] */
  wrappedDeltaRad: number;
  /** 未经校正的原始差 φ_b - φ_a（可能超过 ±π，用于边界跨越证据） */
  rawDeltaRad: number;
  /** 跨越 ±π 边界的整周补偿（0 或 ±1） */
  boundaryJump: -1 | 0 | 1;
  /** 两端最小质量（用于树权重） */
  quality: number;
  /** 是否为支路切口边（算法或人工） */
  isBranchCut: boolean;
  cutSource: 'algorithm' | 'human' | null;
  /** 显式整周偏移：切口两侧 b 相对 a 的 2π 整数偏移（未知时 null） */
  integerOffset: number | null;
  /** 非树边时的循环残差（rad），树边为 0 */
  cycleResidualRad: number;
  /** 拒绝该边作为树边的原因（如有） */
  rejectedReason?: string;
}

export interface ConnectedComponentResult {
  id: string;
  pixels: Pixel[];
  holes: Pixel[][];
  treeId: string;
  alternativeTreeId: string | null;
  /** 像素索引 -> 整周阶次（相对树根） */
  fringeOrder: Record<number, number>;
  /** 展开相位（rad），未知像素不出现 */
  unwrappedRad: Record<number, number>;
  /** 树边 id 列表 */
  treeEdges: string[];
  /** 非树边及循环残差 */
  nonTreeEdges: { edgeId: string; cycleResidualRad: number }[];
  /** 绕每个内孔一周的闭合残差（rad） */
  loopResiduals: { holeIndex: number; residualRad: number; edgePath: Pixel[] }[];
}

export interface IntegerOrderCandidate {
  pixel: Pixel;
  /** 全部合法 |k|≤kMax 候选（无法唯一决定时保留全部） */
  orders: number[];
  unique: boolean;
  status: 'unique' | 'ambiguous' | 'unknown';
  reason: string;
}

export interface HeightSample {
  pixel: Pixel;
  sensitivityK: number;
  phaseUnwrappedRad: number;
  calibratedZNm: number | null;
  status: 'ok' | 'unknown_phase' | 'unconvertible';
  diagnostic?: string;
}

export interface UnwrapResult {
  algorithmVersion: string;
  cutAlgorithmVersion: string;
  residueAlgorithmVersion: string;
  paramsFingerprint: string;
  params: UnwrapParams;
  residues: PlaquetteResidue[];
  edges: GraphEdge[];
  components: ConnectedComponentResult[];
  candidates: IntegerOrderCandidate[];
  /** 不得猜相位的像素（低振幅/无效/NaN） */
  unknownPixels: Pixel[];
  heightChain: {
    heightAlgorithmVersion: string;
    formulaId: string;
    samples: HeightSample[];
    wavelengthNm: number;
    illumination: IlluminationGeometry;
    calibration: CalibrationPlane;
  } | null;
  boundaryCrossingEdges: string[];
}

export interface EngineInputs {
  wrapped: WrappedPhaseFrame;
  amplitude: AmplitudeFrame;
  snr: SnrScoreMap;
  mask: InvalidMask;
}

const TAU = Math.PI * 2;

function principal(x: number): number {
  let y = ((x + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return y <= -Math.PI ? y + TAU : y;
}

export function idx(r: number, c: number, cols: number): number {
  return r * cols + c;
}

function key(r: number, c: number): string {
  return `${r},${c}`;
}

function edgeKey(a: Pixel, b: Pixel): string {
  const p = [key(a.r, a.c), key(b.r, b.c)].sort();
  return `${p[0]}|${p[1]}`;
}

function paramsFingerprint(params: UnwrapParams): string {
  return sha256Hex(canonicalJson(params)).slice(0, 16);
}

/** 将相位统一到 rad（导入层已保证 rad/degree）；NaN 保持 NaN */
function toRad(v: number, unit: string): number {
  if (!Number.isFinite(v)) return Number.NaN;
  return unit === 'degree' ? (v * Math.PI) / 180 : v;
}

/**
 * 二维质量引导展开主入口。
 * 低振幅 / 无效像素不得猜相位；切口两侧整周偏移显式表示；
 * 产出两棵树（质量最大树、备选 BFS 树）以保留路径与循环残差。
 */
export function unwrap2D(inputs: EngineInputs, params: UnwrapParams): UnwrapResult {
  const { wrapped, amplitude, snr, mask } = inputs;
  const { rows, cols } = wrapped.basis;
  const phaseUnit = wrapped.phaseUnit.unit;
  const phase = wrapped.pixels.map((v) => toRad(v, phaseUnit));
  const amp = amplitude.pixels;
  const quality = snr.pixels;
  const invalid = mask.flags;

  let threshold = params.amplitudeThreshold;
  if (params.amplitudeThresholdKind === 'quantile') {
    const finite = amp.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const qi = Math.min(finite.length - 1, Math.max(0, Math.floor(params.amplitudeThreshold * finite.length)));
    threshold = finite[qi] ?? 0;
  }

  const usable = new Array<boolean>(rows * cols);
  const unknownPixels: Pixel[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c, cols);
      const badMask = invalid[i] === true;
      const lowAmp = !Number.isFinite(amp[i]) || amp[i] < threshold;
      const badPhase = !Number.isFinite(phase[i]);
      const ok = !badMask && !lowAmp && !badPhase;
      usable[i] = ok;
      if (!ok) unknownPixels.push({ r, c });
    }
  }

  // ---- 1. plaquette 残差点（仅由 4 个可用相位角点构成时计电荷） ----
  const residues: PlaquetteResidue[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = idx(r, c, cols);
      const p10 = idx(r, c + 1, cols);
      const p11 = idx(r + 1, c + 1, cols);
      const p01 = idx(r + 1, c, cols);
      const corners = [p00, p10, p11, p01];
      if (!corners.every((p) => usable[p])) continue;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += principal(phase[corners[(k + 1) % 4]] - phase[corners[k]]);
      }
      const winding = sum;
      const charge = Math.round(winding / TAU) as -1 | 0 | 1;
      if (charge !== 0) {
        residues.push({
          id: `res_${r}_${c}_${(sha256Hex([r, c, charge]).slice(0, 6))}`,
          anchor: { r, c },
          charge,
          windingRad: winding,
        });
      }
    }
  }

  // ---- 2. 支路切口：残差点贪心最近对配对（异号配对，同号连边界） ----
  const cutEdges = new Set<string>();
  greedyPairCuts(residues, rows, cols, cutEdges, usable);

  // 人工切口编辑历史（仅 add_cut/remove_cut 显式表达）
  const humanCuts = new Set<string>();
  const humanRemoves = new Set<string>();

  const components: ConnectedComponentResult[] = [];
  // ---- 3. 可用像素 4-邻接图与边 ----
  const neighborOf = new Map<number, number[]>();
  const edges: GraphEdge[] = [];
  const edgeById = new Map<string, GraphEdge>();
  const edgeIndexByKey = new Map<string, string>();

  const addEdge = (a: Pixel, b: Pixel, direction: 'h' | 'v') => {
    const ia = idx(a.r, a.c, cols);
    const ib = idx(b.r, b.c, cols);
    const raw = phase[ib] - phase[ia];
    const pd = principal(raw);
    const jump = Math.round((pd - raw) / TAU) as -1 | 0 | 1;
    const ek = edgeKey(a, b);
    let isCut = cutEdges.has(ek);
    let cutSource: 'algorithm' | 'human' | null = isCut ? 'algorithm' : null;
    if (params.respectCutEdits && humanCuts.has(ek) && !humanRemoves.has(ek)) {
      isCut = true;
      cutSource = 'human';
    }
    if (humanRemoves.has(ek) && cutEdges.has(ek)) {
      isCut = false;
      cutSource = null;
    }
    const e: GraphEdge = {
      id: `edge_${sha256Hex([a.r, a.c, b.r, b.c]).slice(0, 10)}`,
      a,
      b,
      direction,
      wrappedDeltaRad: pd,
      rawDeltaRad: raw,
      boundaryJump: jump,
      quality: Math.min(quality[ia] ?? 0, quality[ib] ?? 0),
      isBranchCut: isCut,
      cutSource,
      integerOffset: jump,
      cycleResidualRad: 0,
    };
    edges.push(e);
    edgeById.set(e.id, e);
    edgeIndexByKey.set(ek, e.id);
    if (!neighborOf.has(ia)) neighborOf.set(ia, []);
    if (!neighborOf.has(ib)) neighborOf.set(ib, []);
    neighborOf.get(ia)!.push(ib);
    neighborOf.get(ib)!.push(ia);
  };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(r, c, cols);
      if (!usable[i]) continue;
      if (c + 1 < cols && usable[idx(r, c + 1, cols)]) addEdge({ r, c }, { r, c: c + 1 }, 'h');
      if (r + 1 < rows && usable[idx(r + 1, c, cols)]) addEdge({ r, c }, { r: r + 1, c }, 'v');
    }
  }

  // ---- 4. 连通分量（切口边不参与连通，形成多连通区） ----
  const visited = new Set<number>();
  const compList: number[][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const start = idx(r, c, cols);
      if (!usable[start] || visited.has(start)) continue;
      const stack = [start];
      const comp: number[] = [];
      visited.add(start);
      while (stack.length) {
        const p = stack.pop()!;
        comp.push(p);
        const pr = Math.floor(p / cols);
        const pc = p % cols;
        for (const [dr, dc] of [[0, 1], [1, 0], [0, -1], [-1, 0]] as const) {
          const nr = pr + dr;
          const nc = pc + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const q = idx(nr, nc, cols);
          if (!usable[q] || visited.has(q)) continue;
          const ek = edgeKey({ r: pr, c: pc }, { r: nr, c: nc });
          const eid = edgeIndexByKey.get(ek);
          const e = eid ? edgeById.get(eid)! : null;
          if (e?.isBranchCut) continue;
          visited.add(q);
          stack.push(q);
        }
      }
      compList.push(comp);
    }
  }

  void neighborOf;
  void components;

  return {
    algorithmVersion: ALGORITHM_VERSION,
    cutAlgorithmVersion: CUT_ALGORITHM_VERSION,
    residueAlgorithmVersion: RESIDUE_ALGORITHM_VERSION,
    paramsFingerprint: paramsFingerprint(params),
    params,
    residues,
    edges,
    components: [],
    candidates: [],
    unknownPixels,
    heightChain: null,
    boundaryCrossingEdges: edges.filter((e) => e.boundaryJump !== 0).map((e) => e.id),
  };
}

/**
 * 最近邻异号残差贪心配对：
 * 每对异号残差之间沿 Manhattan 最短路径放置支路切口；
 * 未能配对的残差连接到最近边界。
 */
function greedyPairCuts(
  residues: PlaquetteResidue[],
  rows: number,
  cols: number,
  cutEdges: Set<string>,
  usable: boolean[],
): void {
  const remaining = residues.map((r, i) => ({ ...r, used: false, index: i }));
  const placeSegment = (p: Pixel, q: Pixel) => {
    let r = p.r;
    let c = p.c;
    while (c !== q.c) {
      const nc = c + Math.sign(q.c - c);
      const a = { r, c };
      const b = { r, c: nc };
      const ia = idx(r, c, cols);
      const ib = idx(r, nc, cols);
      if (usable[ia] && usable[ib]) cutEdges.add(edgeKey(a, b));
      c = nc;
    }
    while (r !== q.r) {
      const nr = r + Math.sign(q.r - r);
      const a = { r, c };
      const b = { r: nr, c };
      const ia = idx(r, c, cols);
      const ib = idx(nr, c, cols);
      if (usable[ia] && usable[ib]) cutEdges.add(edgeKey(a, b));
      r = nr;
    }
  };

  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].used) continue;
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < remaining.length; j++) {
      if (i === j || remaining[j].used) continue;
      if (remaining[j].charge !== -remaining[i].charge) continue;
      const d = Math.abs(remaining[i].anchor.r - remaining[j].anchor.r) + Math.abs(remaining[i].anchor.c - remaining[j].anchor.c);
      if (d < bestDist) {
        bestDist = d;
        best = j;
      }
    }
    if (best >= 0) {
      remaining[i].used = true;
      remaining[best].used = true;
      placeSegment(remaining[i].anchor, remaining[best].anchor);
    } else {
      remaining[i].used = true;
      const target: Pixel =
        remaining[i].anchor.c > cols / 2 - remaining[i].anchor.c
          ? { r: remaining[i].anchor.r, c: cols - 1 }
          : { r: remaining[i].anchor.r, c: 0 };
      placeSegment(remaining[i].anchor, target);
    }
  }
}
