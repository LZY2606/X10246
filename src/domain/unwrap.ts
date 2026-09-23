/**
 * 二维相位展开核心算法。
 *
 * 领域铁律：
 *  - 低振幅/被遮罩像素绝不猜相位（结果为 NaN，边标记 invalid）。
 *  - 支路切口两侧的整周偏移显式表示（BranchCut.integerOffsetTurns，未知为 null）。
 *  - 可生成不同展开树；每棵树对局部可能都自洽，保留路径与循环残差。
 *  - 残差（2x2 环绕和非零）必须被切口“放电/隔挡”，否则循环不闭合。
 *  - 无法唯一决定整周数时，保留全部合法候选并标 nonUnique。
 */
import { TWO_PI, wrapToPi } from './units.ts';
import { inBounds, idx } from './frames.ts';

export const ALGO_VERSION = 'unwrap-1.0.0';

export interface AlgoParams {
  /** 振幅低于此阈值视为低振幅（不猜相位）。 */
  amplitudeThreshold: number;
  /** 信噪比阈值（归一化到 0..1）。 */
  snrThreshold: number;
  /** 判定循环不闭合的容差（turns）。 */
  cycleToleranceTurns: number;
  /** 候选整周搜索半径。 */
  kSearchRadius: number;
}

export const DEFAULT_PARAMS: AlgoParams = {
  amplitudeThreshold: 0.25,
  snrThreshold: 0.35,
  cycleToleranceTurns: 0.15,
  kSearchRadius: 2,
};

export function parameterFingerprint(p: AlgoParams): string {
  return 'pf:' + JSON.stringify({
    a: p.amplitudeThreshold,
    s: p.snrThreshold,
    t: p.cycleToleranceTurns,
    k: p.kSearchRadius,
  });
}

export interface Pixel { r: number; c: number }

export interface QualityResult {
  score: Float64Array;     // 0..1
  flags: Uint8Array;       // QualityFlag 编码
}

export const QualityFlag = {
  OK: 0,
  LOW_AMPLITUDE: 1,
  MASKED: 2,
  LOW_SNR: 4,
} as const;
export type QualityFlag = (typeof QualityFlag)[keyof typeof QualityFlag];

/** 质量图：振幅与信噪比相乘式评分；遮罩=0；低振幅=0 且打标。 */
export function computeQualityMap(
  amplitude: Float64Array,
  snr: Float64Array,
  mask: Uint8Array,
  params: AlgoParams,
): QualityResult {
  const n = amplitude.length;
  const score = new Float64Array(n);
  const flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) {
      flags[i] = QualityFlag.MASKED;
      score[i] = 0;
      continue;
    }
    const amp = Number.isFinite(amplitude[i]) ? amplitude[i] : 0;
    const q = Number.isFinite(snr[i]) ? clamp01(snr[i]) : 0;
    let s = clamp01(amp) * (0.4 + 0.6 * q);
    let f = QualityFlag.OK;
    if (amp < params.amplitudeThreshold) {
      // 低振幅：不得猜相位 —— 质量归零并显式打标。
      s = 0;
      f |= QualityFlag.LOW_AMPLITUDE;
    }
    if (q < params.snrThreshold) f |= QualityFlag.LOW_SNR;
    score[i] = s;
    flags[i] = f;
  }
  return { score, flags };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** 包裹相位差：返回 (-pi, pi] 的主值。 */
export function wrappedDelta(a: number, b: number): number {
  return wrapToPi(b - a);
}

export interface ResiduePoint extends Pixel {
  charge: 1 | -1;
  windingTurns: number;
}

/**
 * 残差图：对每个 2x2 像元计算包裹梯度环绕和。
 * 返回 +1（正电荷）/-1（负电荷）残差；环绕和接近 ±2pi。
 * 只在四个像素都有效时计算（不猜相位）。
 */
export function computeResidues(
  phase: Float64Array,
  valid: Uint8Array,
  rows: number,
  cols: number,
): ResiduePoint[] {
  const residues: ResiduePoint[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const p00 = idx(r, c, cols);
      const p01 = idx(r, c + 1, cols);
      const p11 = idx(r + 1, c + 1, cols);
      const p10 = idx(r + 1, c, cols);
      if (!(valid[p00] && valid[p01] && valid[p11] && valid[p10])) continue;
      // 顺时针环绕
      const sum =
        wrappedDelta(phase[p00], phase[p01]) +
        wrappedDelta(phase[p01], phase[p11]) +
        wrappedDelta(phase[p11], phase[p10]) +
        wrappedDelta(phase[p10], phase[p00]);
      const turns = sum / TWO_PI;
      const rounded = Math.round(turns);
      if (rounded !== 0 && Math.abs(turns - rounded) < 0.35) {
        residues.push({ r, c, charge: (rounded > 0 ? 1 : -1) as 1 | -1, windingTurns: turns });
      }
    }
  }
  return residues;
}

export interface Region {
  regionId: string;
  pixels: Pixel[];
  containsHole: boolean;
  holes: Pixel[];
}

export interface RegionResult {
  regions: Region[];
  labels: Int32Array; // 像素 -> 区域下标，-1=无效/孔洞
}

/**
 * 连通区域（4-邻域）。有效像素 = 未遮罩且非低振幅。
 * 孔洞 = 被有效像素包围的无效像素集合（不与边界相连）——支撑“多连通区”。
 */
export function computeRegions(
  mask: Uint8Array,
  qualityFlags: Uint8Array,
  rows: number,
  cols: number,
): RegionResult {
  const valid = new Uint8Array(rows * cols);
  for (let i = 0; i < valid.length; i++) {
    valid[i] = mask[i] && !(qualityFlags[i] & QualityFlag.LOW_AMPLITUDE) ? 1 : 0;
  }
  const labels = new Int32Array(rows * cols).fill(-1);
  const regions: Region[] = [];
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const start = idx(r, c, cols);
      if (!valid[start] || labels[start] !== -1) continue;
      const label = regions.length;
      const pixels: Pixel[] = [];
      const queue: Pixel[] = [{ r, c }];
      labels[start] = label;
      while (queue.length) {
        const p = queue.shift()!;
        pixels.push(p);
        for (const [dr, dc] of dirs) {
          const nr = p.r + dr;
          const nc = p.c + dc;
          if (!inBounds(nr, nc, rows, cols)) continue;
          const ni = idx(nr, nc, cols);
          if (valid[ni] && labels[ni] === -1) {
            labels[ni] = label;
            queue.push({ r: nr, c: nc });
          }
        }
      }
      regions.push({ regionId: 'R' + label, pixels, containsHole: false, holes: [] });
    }
  }

  // 标记孔洞：无效像素中不与边界相连的连通块，归入其包围区域。
  const invLabel = new Int32Array(rows * cols).fill(-1);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const start = idx(r, c, cols);
      if (valid[start] || invLabel[start] !== -1) continue;
      const comp: Pixel[] = [];
      let touchesBorder = false;
      const queue: Pixel[] = [{ r, c }];
      invLabel[start] = -2;
      while (queue.length) {
        const p = queue.shift()!;
        comp.push(p);
        if (p.r === 0 || p.c === 0 || p.r === rows - 1 || p.c === cols - 1) touchesBorder = true;
        for (const [dr, dc] of dirs) {
          const nr = p.r + dr;
          const nc = p.c + dc;
          if (!inBounds(nr, nc, rows, cols)) continue;
          const ni = idx(nr, nc, cols);
          if (!valid[ni] && invLabel[ni] === -1) {
            invLabel[ni] = -2;
            queue.push({ r: nr, c: nc });
          }
        }
      }
      if (!touchesBorder) {
        // 找一个相邻有效像素所属区域（孔洞归属）。
        const owner = findEnclosingRegion(comp, labels, rows, cols, dirs);
        if (owner !== -1) {
          regions[owner].containsHole = true;
          regions[owner].holes.push(...comp);
        }
      }
    }
  }
  return { regions, labels };
}

function findEnclosingRegion(
  comp: Pixel[],
  labels: Int32Array,
  rows: number,
  cols: number,
  dirs: number[][],
): number {
  for (const p of comp) {
    for (const [dr, dc] of dirs) {
      const nr = p.r + dr;
      const nc = p.c + dc;
      if (!inBounds(nr, nc, rows, cols)) continue;
      const l = labels[idx(nr, nc, cols)];
      if (l !== -1) return l;
    }
  }
  return -1;
}

export interface BranchCutEdge {
  cutId: string;
  a: Pixel;
  b: Pixel;
  integerOffsetTurns: number | null;
  kind: 'residue-pair' | 'residue-to-border' | 'human' | 'tree';
  residues: string[];
}

/** 最近邻正负残差配对（确定性：按坐标排序），其余连到边界。 */
export function pairResidues(
  residues: ResiduePoint[],
  rows: number,
  cols: number,
): BranchCutEdge[] {
  const sorted = residues
    .map((x, i) => ({ ...x, rid: 'res:' + i }))
    .sort((p, q) => p.r - q.r || p.c - q.c);
  const used = new Set<string>();
  const cuts: BranchCutEdge[] = [];
  const positives = sorted.filter((x) => x.charge === 1 && !used.has(x.rid));
  for (const pos of positives) {
    let best: (typeof sorted)[number] | null = null;
    let bestD = Infinity;
    for (const neg of sorted) {
      if (neg.charge !== -1 || used.has(neg.rid)) continue;
      const d = Math.abs(neg.r - pos.r) + Math.abs(neg.c - pos.c);
      if (d < bestD) {
        bestD = d;
        best = neg;
      }
    }
    if (best) {
      used.add(pos.rid);
      used.add(best.rid);
      cuts.push({
        cutId: 'cut:' + pos.rid + '<->' + best.rid,
        a: { r: pos.r, c: pos.c },
        b: { r: best.r, c: best.c },
        // 整周偏移在跨切口展开时才能决定；此处未知（不猜）。
        integerOffsetTurns: null,
        kind: 'residue-pair',
        residues: [pos.rid, best.rid],
      });
    } else {
      used.add(pos.rid);
      cuts.push({
        cutId: 'cut:' + pos.rid + '->border',
        a: { r: pos.r, c: pos.c },
        b: nearestBorder(pos, rows, cols),
        integerOffsetTurns: null,
        kind: 'residue-to-border',
        residues: [pos.rid],
      });
    }
  }
  for (const neg of sorted) {
    if (neg.charge === -1 && !used.has(neg.rid)) {
      used.add(neg.rid);
      cuts.push({
        cutId: 'cut:' + neg.rid + '->border',
        a: { r: neg.r, c: neg.c },
        b: nearestBorder(neg, rows, cols),
        integerOffsetTurns: null,
        kind: 'residue-to-border',
        residues: [neg.rid],
      });
    }
  }
  return cuts;
}

function nearestBorder(p: Pixel, rows: number, cols: number): Pixel {
  const opts: Pixel[] = [
    { r: 0, c: p.c },
    { r: rows - 1, c: p.c },
    { r: p.r, c: 0 },
    { r: p.r, c: cols - 1 },
  ];
  let best = opts[0];
  let bd = p.r;
  const dists = [p.r, rows - 1 - p.r, p.c, cols - 1 - p.c];
  for (let i = 1; i < 4; i++) if (dists[i] < bd) { bd = dists[i]; best = opts[i]; }
  return best;
}

export interface TreeEdge {
  from: Pixel;
  to: Pixel;
  deltaTurns: number | null;
  valid: boolean;
}

export interface CycleResidual {
  cycleId: string;
  vertices: Pixel[];
  residualTurns: number;
  closed: boolean;
}

export interface UnwrapTreeResult {
  variant: string;
  root: Pixel;
  regionId: string;
  edges: TreeEdge[];
  unwrapped: Float64Array;
  cycles: CycleResidual[];
  /** 被切口跨越的像素对（整周偏移显式求解或为 null）。 */
  cutOffsets: Array<{ cutId: string; a: Pixel; b: Pixel; offsetTurns: number | null }>;
}

/**
 * 在一个连通区域上做质量引导 / BFS 的洪水填充展开（Itoh 沿路径累加包裹差）。
 * 低振幅/遮罩像素为 NaN；跨切口边的整周增量初始未知（null）。
 */
export function growUnwrapTree(opts: {
  variant: string;
  region: Region;
  labels: Int32Array;
  phase: Float64Array;
  quality: Float64Array;
  cuts: BranchCutEdge[];
  rows: number;
  cols: number;
  params: AlgoParams;
}): UnwrapTreeResult {
  const { variant, region, labels, phase, quality, cuts, rows, cols, params } = opts;
  const unwrapped = new Float64Array(rows * cols).fill(NaN);
  const visited = new Uint8Array(rows * cols);
  const edges: TreeEdge[] = [];
  // 根：区域内质量最高像素（确定）。
  let root = region.pixels[0];
  let bestQ = -1;
  for (const p of region.pixels) {
    const q = quality[idx(p.r, p.c, cols)];
    if (q > bestQ) { bestQ = q; root = p; }
  }
  unwrapped[idx(root.r, root.c, cols)] = phase[idx(root.r, root.c, cols)];
  visited[idx(root.r, root.c, cols)] = 1;

  const cutIndex = buildCutIndex(cuts);
  // 优先队列按质量引导（质量高先展开）；BFS 变体忽略质量。
  const heap: Pixel[] = [root];
  const pop = (): Pixel => {
    if (variant === 'bfs-border') return heap.shift()!;
    let bi = 0;
    for (let i = 1; i < heap.length; i++) {
      if (quality[idx(heap[i].r, heap[i].c, cols)] > quality[idx(heap[bi].r, heap[bi].c, cols)]) bi = i;
    }
    return heap.splice(bi, 1)[0];
  };
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  while (heap.length) {
    const cur = pop();
    for (const [dr, dc] of dirs) {
      const nr = cur.r + dr;
      const nc = cur.c + dc;
      if (!inBounds(nr, nc, rows, cols)) continue;
      const ni = idx(nr, nc, cols);
      if (labels[ni] !== labels[idx(cur.r, cur.c, cols)]) continue;
      const cut = cutIndex.get(edgeKey(cur, { r: nr, c: nc }));
      if (cut) {
        // 切口跨越：整周偏移未知 -> 不猜；记录显式 null。
        edges.push({ from: cur, to: { r: nr, c: nc }, deltaTurns: null, valid: false });
        continue;
      }
      if (visited[ni]) continue;
      const d = wrappedDelta(phase[idx(cur.r, cur.c, cols)], phase[ni]) / TWO_PI;
      edges.push({ from: cur, to: { r: nr, c: nc }, deltaTurns: d, valid: true });
      unwrapped[ni] = unwrapped[idx(cur.r, cur.c, cols)] + d * TWO_PI;
      visited[ni] = 1;
      heap.push({ r: nr, c: nc });
    }
  }

  // 对每条切口，用两端已展开相位推断整周偏移（若两端可达）；否则 null。
  const cutOffsets: UnwrapTreeResult['cutOffsets'] = [];
  for (const cut of cuts) {
    const ua = unwrapped[idx(cut.a.r, cut.a.c, cols)];
    const ub = unwrapped[idx(cut.b.r, cut.b.c, cols)];
    let offset: number | null = null;
    if (Number.isFinite(ua) && Number.isFinite(ub)) {
      // 两侧展开值与包裹值之差给出整周偏移
      const pa = phase[idx(cut.a.r, cut.a.c, cols)];
      const pb = phase[idx(cut.b.r, cut.b.c, cols)];
      const raw = (ub - ua - wrappedDelta(pa, pb)) / TWO_PI;
      offset = Math.round(raw);
    }
    cutOffsets.push({ cutId: cut.cutId, a: cut.a, b: cut.b, offsetTurns: offset });
  }

  const cycles = computeCycleResiduals({
    region, labels, phase, unwrapped, cuts, rows, cols, params,
  });

  return { variant, root, regionId: region.regionId, edges, unwrapped, cycles, cutOffsets };
}

function edgeKey(a: Pixel, b: Pixel): string {
  const ka = a.r + ':' + a.c;
  const kb = b.r + ':' + b.c;
  return ka < kb ? ka + '|' + kb : kb + '|' + ka;
}

function buildCutIndex(cuts: BranchCutEdge[]): Map<string, BranchCutEdge> {
  const m = new Map<string, BranchCutEdge>();
  for (const cut of cuts) {
    // 切口沿连接 a→b 的逐边路径（直线步进）加入索引。
    for (const seg of rasterLine(cut.a, cut.b)) m.set(edgeKey(seg.a, seg.b), cut);
  }
  return m;
}

function rasterLine(a: Pixel, b: Pixel): Array<{ a: Pixel; b: Pixel }> {
  const out: Array<{ a: Pixel; b: Pixel }> = [];
  let r = a.r;
  let c = a.c;
  const dr = Math.sign(b.r - a.r);
  const dc = Math.sign(b.c - a.c);
  let guard = 0;
  while ((r !== b.r || c !== b.c) && guard++ < 10000) {
    const nr = r === b.r ? r : r + dr;
    const nc = c === b.c ? c : c + dc;
    out.push({ a: { r, c }, b: { r: nr, c: nc } });
    r = nr;
    c = nc;
  }
  return out;
}

/**
 * 循环残差：在区域内每个 2x2 单元用“已展开相位”重算闭合环绕和。
 * 理想为 0；当区域包含未被正确隔挡的残差时非整数/非零 -> 循环不闭合。
 * 同时显式标注被切口隔开导致无法闭合的环（缺边）。
 */
function computeCycleResiduals(opts: {
  region: Region;
  labels: Int32Array;
  phase: Float64Array;
  unwrapped: Float64Array;
  cuts: BranchCutEdge[];
  rows: number;
  cols: number;
  params: AlgoParams;
}): CycleResidual[] {
  const { region, labels, phase, unwrapped, rows, cols, params } = opts;
  const member = new Set(region.pixels.map((p) => idx(p.r, p.c, cols)));
  const out: CycleResidual[] = [];
  let n = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const corners = [
        idx(r, c, cols),
        idx(r, c + 1, cols),
        idx(r + 1, c + 1, cols),
        idx(r + 1, c, cols),
      ];
      if (!corners.every((i) => member.has(i))) continue;
      const verts: Pixel[] = [
        { r, c },
        { r, c: c + 1 },
        { r: r + 1, c: c + 1 },
        { r: r + 1, c },
      ];
      const uv = corners.map((i) => unwrapped[i]);
      if (!uv.every((x) => Number.isFinite(x))) {
        out.push({
          cycleId: 'cyc:' + r + ':' + c,
          vertices: verts,
          residualTurns: NaN,
          closed: false,
        });
        continue;
      }
      // 用展开相位直接做差分环和（应为 0）
      let res = 0;
      for (let e = 0; e < 4; e++) {
        const i0 = corners[e];
        const i1 = corners[(e + 1) % 4];
        res += wrapDiffUnwrapped(phase[i0], phase[i1], unwrapped[i0], unwrapped[i1]);
      }
      res /= TWO_PI;
      n++;
      out.push({
        cycleId: 'cyc:' + r + ':' + c,
        vertices: verts,
        residualTurns: res,
        closed: Math.abs(res) <= params.cycleToleranceTurns,
      });
    }
  }
  void n;
  return out;
}

/** 给定两端展开相位，求“展开增量 - 包裹增量”（turns 前的弧度差）。 */
function wrapDiffUnwrapped(pa: number, pb: number, ua: number, ub: number): number {
  const span = ub - ua;
  const w = wrappedDelta(pa, pb);
  return span - w;
}

export interface IntegerAmbiguity {
  ambiguityId: string;
  location: Pixel;
  kind: 'across-cut' | 'tree-junction' | 'residue';
  options: Array<{
    k: number;
    legal: boolean;
    adopted: boolean;
    rejectReason: string | null;
    residualTurns: number;
    supportCount: number;
  }>;
  nonUnique: boolean;
}

/**
 * 整周候选：对每个跨切口/残差位置枚举 k ∈ [-R,R]。
 * 用相邻循环残差判定合法性：能把残差收敛到容差内的 k 合法。
 * 不唯一（多个 legal）时保留全部合法候选；不擅自采纳。
 */
export function enumerateIntegerCandidates(
  tree: UnwrapTreeResult,
  params: AlgoParams,
): IntegerAmbiguity[] {
  const ambiguities: IntegerAmbiguity[] = [];
  const cutLocs = tree.cutOffsets.filter((x) => x.offsetTurns === null);
  const worstCycles = [...tree.cycles]
    .filter((c) => !Number.isNaN(c.residualTurns))
    .sort((a, b) => Math.abs(b.residualTurns) - Math.abs(a.residualTurns));

  cutLocs.forEach((co, ai) => {
    const localResid = nearestCycleResidual(worstCycles, co.a);
    const base = localResid ? localResid.residualTurns : 0;
    const options = [] as IntegerAmbiguity['options'];
    for (let k = -params.kSearchRadius; k <= params.kSearchRadius; k++) {
      const residual = base - k; // 给切口加 k 整周偏移后残差变化
      const legal = Math.abs(residual) <= params.cycleToleranceTurns;
      options.push({
        k,
        legal,
        adopted: false,
        rejectReason: legal ? null : 'RESIDUAL_OUT_OF_TOLERANCE',
        residualTurns: residual,
        supportCount: legal ? 1 : 0,
      });
    }
    const legalCount = options.filter((o) => o.legal).length;
    ambiguities.push({
      ambiguityId: 'amb:cut:' + ai,
      location: co.a,
      kind: 'across-cut',
      options,
      nonUnique: legalCount > 1,
    });
  });

  // 残差点附近：若该残差未被任何切口完全放电，也产生多解。
  tree.cycles
    .filter((c) => !c.closed && !Number.isNaN(c.residualTurns))
    .forEach((cyc, i) => {
      const base = cyc.residualTurns;
      const loc = cyc.vertices[0];
      if (ambiguities.some((a) => a.location.r === loc.r && a.location.c === loc.c)) return;
      const options = [] as IntegerAmbiguity['options'];
      for (let k = -params.kSearchRadius; k <= params.kSearchRadius; k++) {
        const residual = base - k;
        const legal = Math.abs(residual) <= params.cycleToleranceTurns;
        options.push({
          k,
          legal,
          adopted: false,
          rejectReason: legal ? null : 'RESIDUAL_OUT_OF_TOLERANCE',
          residualTurns: residual,
          supportCount: legal ? 1 : 0,
        });
      }
      ambiguities.push({
        ambiguityId: 'amb:res:' + i,
        location: loc,
        kind: 'residue',
        options,
        nonUnique: options.filter((o) => o.legal).length !== 1,
      });
    });

  return ambiguities;
}

function nearestCycleResidual(cycles: CycleResidual[], p: Pixel): CycleResidual | null {
  let best: CycleResidual | null = null;
  let bd = Infinity;
  for (const c of cycles) {
    for (const v of c.vertices) {
      const d = Math.abs(v.r - p.r) + Math.abs(v.c - p.c);
      if (d < bd) { bd = d; best = c; }
    }
  }
  return best;
}
