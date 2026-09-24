/**
 * 二维相位展开领域核心。
 *
 * 领域规则（一等数据，不允许被静默吞掉）：
 * - 低振幅/低信噪区域不得猜相位：质量低于阈值的像素标记为 unknown，永不填值。
 * - 切口两侧的整周偏移显式表示：每条切口边携带整数 k 偏移。
 * - 不同展开树可得到局部一致解：候选保留路径指纹与循环残差，全部合法候选都保留。
 */
import { Grid, Region, fullRegion, idx, inBounds, wrapDiff } from './grid.js';

export const UNWRAP_ALGORITHM_VERSION = 'unwrap/1.2.0';

export interface UnwrapParams {
  /** 信噪评分阈值：低于该值的像素为 unknown，不得猜相位。 */
  qualityThreshold: number;
  /** 展开树种子策略。不同策略产生不同展开树 → 不同候选。 */
  strategy: 'best-quality' | 'corner' | 'center';
  /** 切口配对顺序，影响切口网络形状。 */
  cutPairing: 'nearest' | 'farthest';
  /** 限制计算区域（局部依赖）。 */
  region?: Region;
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  qualityThreshold: 0.2,
  strategy: 'best-quality',
  cutPairing: 'nearest',
};

/** 一条网格边：dir 'h' 表示 (x,y)-(x+1,y)，'v' 表示 (x,y)-(x,y+1)。 */
export interface Edge {
  x: number;
  y: number;
  dir: 'h' | 'v';
}

/** 切口边：两侧的整周偏移显式记录。 */
export interface CutEdge extends Edge {
  /** 沿边正向跨越时的整周偏移（整数个 2π）。 */
  kOffset: number;
}

/** 2x2 环路的残差（单位：个整周）。非零即循环不闭合。 */
export interface CycleResidual {
  x: number;
  y: number;
  /** 环路积分 ÷ 2π，理想为 0。 */
  residue: number;
}

export interface UnwrapCandidate {
  /** 整周偏移场；unknown 像素为 null。 */
  k: (number | null)[];
  /** 展开相位（rad）；unknown 像素为 null。 */
  unwrapped: (number | null)[];
  /** 不得猜相位的像素（低振幅/遮罩）。 */
  unknownCells: number[];
  /** 连通分量 id（多连通区每个分量独立基准）。 */
  componentOf: (number | null)[];
  componentCount: number;
  cuts: CutEdge[];
  cycles: CycleResidual[];
  /** 展开树父指针序列的指纹，标识这棵树。 */
  pathHash: string;
  /** 展开后所有环路残差是否为零。 */
  consistent: boolean;
  params: UnwrapParams;
}

export interface UnwrapInput {
  wrappedPhase: Grid;
  quality: Grid;
  invalidMask: Grid; // 0 = 有效, 1 = 无效
}

function edgeKey(e: Edge): string {
  return `${e.x},${e.y},${e.dir}`;
}

/** 计算每个 2x2 环路的包裹梯度残差（Goldstein 残差）。 */
export function computeResidues(input: UnwrapInput, valid: boolean[]): CycleResidual[] {
  const { wrappedPhase } = input;
  const out: CycleResidual[] = [];
  for (let y = 0; y < wrappedPhase.height - 1; y++) {
    for (let x = 0; x < wrappedPhase.width - 1; x++) {
      const i00 = idx(wrappedPhase, x, y);
      const i10 = idx(wrappedPhase, x + 1, y);
      const i11 = idx(wrappedPhase, x + 1, y + 1);
      const i01 = idx(wrappedPhase, x, y + 1);
      if (!valid[i00] || !valid[i10] || !valid[i11] || !valid[i01]) continue;
      const p00 = wrappedPhase.data[i00];
      const p10 = wrappedPhase.data[i10];
      const p11 = wrappedPhase.data[i11];
      const p01 = wrappedPhase.data[i01];
      const sum =
        wrapDiff(p00, p10) + wrapDiff(p10, p11) + wrapDiff(p11, p01) + wrapDiff(p01, p00);
      const residue = Math.round(sum / (2 * Math.PI));
      if (residue !== 0) out.push({ x, y, residue });
    }
  }
  return out;
}

/** 支路切口：把正负残差配对，用 L 形路径连接，路径上的边成为切口。 */
export function computeCutNetwork(
  input: UnwrapInput,
  valid: boolean[],
  pairing: 'nearest' | 'farthest',
): Edge[] {
  const residues = computeResidues(input, valid);
  const pos = residues.filter((r) => r.residue > 0);
  const neg = residues.filter((r) => r.residue < 0);
  const cuts = new Map<string, Edge>();
  const usedNeg = new Set<number>();
  const orderedPos = [...pos].sort((a, b) => a.y - b.y || a.x - b.x);
  for (const p of orderedPos) {
    let best = -1;
    let bestDist = pairing === 'nearest' ? Infinity : -Infinity;
    for (let n = 0; n < neg.length; n++) {
      if (usedNeg.has(n)) continue;
      const q = neg[n];
      const d = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
      if (pairing === 'nearest' ? d < bestDist : d > bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (best < 0) continue;
    usedNeg.add(best);
    const q = neg[best];
    // L 形路径：先水平后垂直。
    const [x0, x1] = p.x <= q.x ? [p.x, q.x] : [q.x, p.x];
    for (let x = x0; x < x1; x++) {
      const e: Edge = { x, y: p.y, dir: 'h' };
      cuts.set(edgeKey(e), e);
    }
    const [y0, y1] = p.y <= q.y ? [p.y, q.y] : [q.y, p.y];
    for (let y = y0; y < y1; y++) {
      const e: Edge = { x: q.x, y, dir: 'v' };
      cuts.set(edgeKey(e), e);
    }
  }
  return [...cuts.values()].sort((a, b) => a.y - b.y || a.x - b.x || a.dir.localeCompare(b.dir));
}

function seedIndex(
  input: UnwrapInput,
  valid: boolean[],
  region: Region,
  strategy: UnwrapParams['strategy'],
): number {
  const { quality } = input;
  if (strategy === 'corner') {
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++) {
        const i = idx(input.wrappedPhase, x, y);
        if (valid[i]) return i;
      }
    return -1;
  }
  if (strategy === 'center') {
    const cx = region.x + Math.floor(region.width / 2);
    const cy = region.y + Math.floor(region.height / 2);
    let best = -1;
    let bestDist = Infinity;
    for (let y = region.y; y < region.y + region.height; y++)
      for (let x = region.x; x < region.x + region.width; x++) {
        const i = idx(input.wrappedPhase, x, y);
        if (!valid[i]) continue;
        const d = Math.abs(x - cx) + Math.abs(y - cy);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    return best;
  }
  // best-quality
  let best = -1;
  let bestQ = -Infinity;
  for (let y = region.y; y < region.y + region.height; y++)
    for (let x = region.x; x < region.x + region.width; x++) {
      const i = idx(input.wrappedPhase, x, y);
      if (!valid[i]) continue;
      if (quality.data[i] > bestQ) {
        bestQ = quality.data[i];
        best = i;
      }
    }
  return best;
}

/** 简单稳定的指纹（FNV-1a），用于展开树路径标识。 */
export function pathFingerprint(values: (number | null)[]): string {
  let h = 0x811c9dc5;
  for (const v of values) {
    const n = v === null ? 0x7fffffff : (v as number) + 0x10000;
    h ^= n & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (n >>> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 用一组参数生成一个展开候选。 */
export function unwrapCandidate(input: UnwrapInput, params: UnwrapParams): UnwrapCandidate {
  const { wrappedPhase, quality, invalidMask } = input;
  const size = wrappedPhase.width * wrappedPhase.height;
  const region = params.region ?? fullRegion(wrappedPhase);

  const valid: boolean[] = new Array(size).fill(false);
  const unknownCells: number[] = [];
  for (let y = 0; y < wrappedPhase.height; y++) {
    for (let x = 0; x < wrappedPhase.width; x++) {
      const i = idx(wrappedPhase, x, y);
      const inside =
        x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height;
      // 领域规则：低振幅/被遮罩的像素不得猜相位。
      const ok = inside && invalidMask.data[i] === 0 && quality.data[i] >= params.qualityThreshold;
      valid[i] = ok;
      if (!ok) unknownCells.push(i);
    }
  }

  const cutEdges = computeCutNetwork(input, valid, params.cutPairing);
  const cutSet = new Set(cutEdges.map(edgeKey));

  const k: (number | null)[] = new Array(size).fill(null);
  const unwrapped: (number | null)[] = new Array(size).fill(null);
  const componentOf: (number | null)[] = new Array(size).fill(null);
  const parent: (number | null)[] = new Array(size).fill(null);

  let componentCount = 0;
  // 多连通区：BFS 耗尽后若还有未访问有效像素，则开启新分量（独立整周基准）。
  for (;;) {
    const seed = seedIndex(
      input,
      valid.map((v, i) => v && componentOf[i] === null),
      region,
      params.strategy,
    );
    if (seed < 0) break;
    const queue: number[] = [seed];
    k[seed] = 0;
    unwrapped[seed] = wrappedPhase.data[seed];
    componentOf[seed] = componentCount;
    parent[seed] = seed;
    while (queue.length > 0) {
      const cur = queue.shift() as number;
      const cx = cur % wrappedPhase.width;
      const cy = Math.floor(cur / wrappedPhase.width);
      const neighbors: Array<[number, number, Edge]> = [
        [cx + 1, cy, { x: cx, y: cy, dir: 'h' }],
        [cx - 1, cy, { x: cx - 1, y: cy, dir: 'h' }],
        [cx, cy + 1, { x: cx, y: cy, dir: 'v' }],
        [cx, cy - 1, { x: cx, y: cy - 1, dir: 'v' }],
      ];
      for (const [nx, ny, edge] of neighbors) {
        if (!inBounds(wrappedPhase, nx, ny)) continue;
        const ni = idx(wrappedPhase, nx, ny);
        if (!valid[ni] || componentOf[ni] !== null) continue;
        if (cutSet.has(edgeKey(edge))) continue; // 切口不可跨越
        const next = (unwrapped[cur] as number) + wrapDiff(wrappedPhase.data[cur], wrappedPhase.data[ni]);
        unwrapped[ni] = next;
        k[ni] = Math.round((next - wrappedPhase.data[ni]) / (2 * Math.PI));
        componentOf[ni] = componentCount;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
    componentCount++;
  }

  // 切口两侧的整周偏移显式表示。
  const cuts: CutEdge[] = cutEdges.map((e) => {
    const a = idx(wrappedPhase, e.x, e.y);
    const b = e.dir === 'h' ? idx(wrappedPhase, e.x + 1, e.y) : idx(wrappedPhase, e.x, e.y + 1);
    const ka = k[a];
    const kb = k[b];
    const kOffset = ka !== null && kb !== null ? kb - ka : 0;
    return { ...e, kOffset };
  });

  // 展开后的循环残差：每条边的整周剩余 m = round((Δu - wrapDiff(Δp)) / 2π)，
  // 沿 2x2 环路求和；非零即不闭合（展开场自身差分沿环路恒为零，必须看整周剩余）。
  const edgeM = (a: number, b: number): number => {
    const ua = unwrapped[a];
    const ub = unwrapped[b];
    if (ua === null || ub === null) return 0;
    return Math.round((ub - ua - wrapDiff(wrappedPhase.data[a], wrappedPhase.data[b])) / (2 * Math.PI));
  };
  const cycles: CycleResidual[] = [];
  for (let y = 0; y < wrappedPhase.height - 1; y++) {
    for (let x = 0; x < wrappedPhase.width - 1; x++) {
      const i00 = idx(wrappedPhase, x, y);
      const i10 = idx(wrappedPhase, x + 1, y);
      const i11 = idx(wrappedPhase, x + 1, y + 1);
      const i01 = idx(wrappedPhase, x, y + 1);
      const ids = [i00, i10, i11, i01];
      if (ids.some((i) => unwrapped[i] === null)) continue;
      if (new Set(ids.map((i) => componentOf[i])).size !== 1) continue;
      const residue = edgeM(i00, i10) + edgeM(i10, i11) + edgeM(i11, i01) + edgeM(i01, i00);
      if (residue !== 0) cycles.push({ x, y, residue });
    }
  }

  return {
    k,
    unwrapped,
    unknownCells,
    componentOf,
    componentCount,
    cuts,
    cycles,
    pathHash: pathFingerprint(parent),
    consistent: cycles.length === 0,
    params,
  };
}

/** 生成全部整周候选：不同展开树可能给出局部一致的不同解，全部保留。 */
export function generateCandidates(input: UnwrapInput, base: UnwrapParams): UnwrapCandidate[] {
  const variants: UnwrapParams[] = [
    base,
    { ...base, strategy: 'corner' },
    { ...base, strategy: 'center' },
    { ...base, cutPairing: base.cutPairing === 'nearest' ? 'farthest' : 'nearest' },
  ];
  const seen = new Set<string>();
  const out: UnwrapCandidate[] = [];
  for (const v of variants) {
    const c = unwrapCandidate(input, v);
    const signature = `${c.pathHash}:${c.k.map((x) => x ?? 'u').join(',')}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    out.push(c);
  }
  return out;
}
