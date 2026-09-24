import type {
  BranchCutEdge,
  BranchCutNetworkPayload,
  QualityMapPayload,
  ResidueCharge,
  ResidueMapPayload,
  WrappedPhaseInput
} from './types.js';
import { idx, TWO_PI, wrapToPi } from './geometry.js';

export const RESIDUE_ALGO_VERSION = 'residue.v1';
export const CUT_ALGO_VERSION = 'branchcut.v3';

export interface ResidueParams {
  /** 判定残差的缠绕和阈值（|sum| 超过该阈值的整周数才计电荷） */
  chargeThreshold: number;
}
export const DEFAULT_RESIDUE_PARAMS: ResidueParams = { chargeThreshold: Math.PI * 0.5 };

export function residueFingerprint(p: ResidueParams): string {
  return `charge>=${p.chargeThreshold.toFixed(4)}`;
}

/**
 * 2x2 plaquette 有向缠绕和：
 * 沿 (u,v)->(u+1,v)->(u+1,v+1)->(u,v+1) 闭合求和。
 * 理想连续场应为 0；出现 ±2π 表示该格含一个 +1/-1 残差点。
 */
export function computeResidueMap(
  phase: WrappedPhaseInput,
  quality: QualityMapPayload,
  params: ResidueParams = DEFAULT_RESIDUE_PARAMS
): ResidueMapPayload {
  const { width: w, height: h } = phase;
  const charges: ResidueCharge[] = [];
  const usable = (u: number, v: number) => quality.score[idx(u, v, w)] !== null;

  for (let v = 0; v < h - 1; v++) {
    for (let u = 0; u < w - 1; u++) {
      if (!usable(u, v) || !usable(u + 1, v) || !usable(u + 1, v + 1) || !usable(u, v + 1)) {
        continue; // 低振幅/无效区域：不猜，也不据此造残差
      }
      const p00 = phase.raw[idx(u, v, w)];
      const p10 = phase.raw[idx(u + 1, v, w)];
      const p11 = phase.raw[idx(u + 1, v + 1, w)];
      const p01 = phase.raw[idx(u, v + 1, w)];
      const sum =
        wrapToPi(p10 - p00) +
        wrapToPi(p11 - p10) +
        wrapToPi(p01 - p11) +
        wrapToPi(p00 - p01);
      const rounded = Math.round(sum / TWO_PI);
      if (rounded !== 0 && Math.abs(sum) >= params.chargeThreshold) {
        charges.push({ u, v, charge: rounded > 0 ? 1 : -1, value: sum });
      }
    }
  }
  return {
    kind: 'residue_map',
    width: w,
    height: h,
    charges,
    algorithmVersion: RESIDUE_ALGO_VERSION,
    parameterFingerprint: residueFingerprint(params)
  };
}

export interface CutParams {
  /** 极性相反残差配对的最大曼哈顿距离；超过则留作未配对（孔洞/边界） */
  maxPairDistance: number;
  /** 是否在图像边界放守卫切口 */
  borderGuard: boolean;
}
export const DEFAULT_CUT_PARAMS: CutParams = { maxPairDistance: 4, borderGuard: true };
export function cutFingerprint(p: CutParams): string {
  return `pair<=${p.maxPairDistance};border=${p.borderGuard ? 1 : 0}`;
}

/**
 * 支路切口网络：
 * - 贪心把最近的 +1/-1 残差沿曼哈顿路径连成切口，切口边带显式整周偏移（初始未知 => null，绝不猜）。
 * - 配不上对的残差点保留为 unpairedResidues（常见于低振幅孔洞、多连通区、边界）。
 * - 边界守卫切口把未配对残差引到边界。
 */
export function computeBranchCuts(
  residues: ResidueMapPayload,
  params: CutParams = DEFAULT_CUT_PARAMS
): BranchCutNetworkPayload {
  const { width: w, height: h } = residues;
  const remaining = new Map<number, ResidueCharge>();
  residues.charges.forEach((c, i) => remaining.set(i, c));
  const edges: BranchCutEdge[] = [];
  const used = new Set<number>();

  const manhattan = (a: ResidueCharge, b: ResidueCharge) =>
    Math.abs(a.u - b.u) + Math.abs(a.v - b.v);

  let guard = 0;
  // 反复找最近的异号对
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let best: { ai: number; bi: number; dist: number } | null = null;
    const arr = [...remaining.entries()].filter(([i]) => !used.has(i));
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const [ai, a] = arr[x];
        const [bi, b] = arr[y];
        if (a.charge === b.charge) continue;
        const dist = manhattan(a, b);
        if (dist > params.maxPairDistance) continue;
        if (!best || dist < best.dist) best = { ai, bi, dist };
      }
    }
    if (!best) break;
    const a = remaining.get(best.ai)!;
    const b = remaining.get(best.bi)!;
    used.add(best.ai);
    used.add(best.bi);
    for (const edge of manhattanPath([a.u, a.v], [b.u, b.v])) {
      edges.push({
        id: `cut:${edge.a[0]},${edge.a[1]}|${edge.b[0]},${edge.b[1]}`,
        a: edge.a,
        b: edge.b,
        integerOffset: null,
        source: 'residue_pair',
        pairedResidues: [a, b]
      });
    }
  }

  const unpaired = [...remaining.entries()].filter(([i]) => !used.has(i)).map(([, c]) => c);

  if (params.borderGuard) {
    for (const r of unpaired) {
      // 引到最近边界
      const target: [number, number] =
        r.u <= r.v
          ? r.u <= w - 1 - r.u
            ? [0, r.v]
            : [w - 1, r.v]
          : r.v <= h - 1 - r.v
            ? [r.u, 0]
            : [r.u, h - 1];
      for (const edge of manhattanPath([r.u, r.v], target)) {
        edges.push({
          id: `guard:${guard++}:${edge.a[0]},${edge.a[1]}|${edge.b[0]},${edge.b[1]}`,
          a: edge.a,
          b: edge.b,
          integerOffset: null,
          source: 'border_guard'
        });
      }
    }
  }

  // 去重（同一条像素边可能被多次覆盖）
  const dedup = new Map<string, BranchCutEdge>();
  for (const e of edges) if (!dedup.has(stableEdgeKey(e.a, e.b))) dedup.set(stableEdgeKey(e.a, e.b), e);

  return {
    kind: 'branch_cut_network',
    width: w,
    height: h,
    edges: [...dedup.values()],
    unpairedResidues: params.borderGuard ? [] : unpaired,
    algorithmVersion: CUT_ALGO_VERSION,
    parameterFingerprint: cutFingerprint(params)
  };
}

export function stableEdgeKey(a: [number, number], b: [number, number]): string {
  const ka = `${a[0]},${a[1]}`;
  const kb = `${b[0]},${b[1]}`;
  return [ka, kb].sort().join('|');
}

function manhattanPath(a: [number, number], b: [number, number]): { a: [number, number]; b: [number, number] }[] {
  const out: { a: [number, number]; b: [number, number] }[] = [];
  let [u, v] = a;
  const [tu, tv] = b;
  while (u !== tu) {
    const nu = u + Math.sign(tu - u);
    out.push({ a: [u, v], b: [nu, v] });
    u = nu;
  }
  while (v !== tv) {
    const nv = v + Math.sign(tv - v);
    out.push({ a: [u, v], b: [u, nv] });
    v = nv;
  }
  return out;
}
