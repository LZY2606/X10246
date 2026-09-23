import type {
  CutEdge,
  Grid,
  MaskGrid,
  Pixel,
  UnwrapCandidatePayload,
} from '../shared/types.ts';
import { edgeKey, neighbors, pixelKey, shape, wrappedDiff } from './grid.ts';

export const UNWRAP_ALGORITHM = 'spanning-tree-unwrap/v1';

export interface UnwrapParams {
  /** 展开树种子点（不同展开树可得到局部一致解） */
  seeds: Pixel[];
  /** 整周多解枚举：不连通区域允许的整体整数平移 */
  freeIntegerShifts: number[];
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  seeds: [
    [0, 0],
    [0, -1], // 归一化时解析为角点 / 中心
  ],
  freeIntegerShifts: [-1, 0, 1],
};

export function resolveSeeds(rows: number, cols: number): Pixel[] {
  return [
    [0, 0],
    [Math.floor(rows / 2), Math.floor(cols / 2)],
  ];
}

/**
 * 单棵展开树：BFS 积分包裹梯度。
 * - 低振幅 / 无效像素为未知，不猜相位（phase = null）。
 * - 跨越切口的边记录显式整周偏移 kOffsets。
 * - 不连通区域各自积分，相对整周数自由（整周多解）。
 */
export function unwrapWithSeed(
  wrapped: Grid,
  valid: MaskGrid,
  cuts: CutEdge[],
  seed: Pixel,
  regionShifts: Map<number, number>,
): UnwrapCandidatePayload {
  const { rows, cols } = shape(wrapped);
  const cutSet = new Set(cuts.map((e) => edgeKey(e.a, e.b)));
  const phase: (number | null)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );
  const regionOf: (number | null)[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => null),
  );
  const tree: { from: Pixel; to: Pixel }[] = [];
  const kOffsets: { edge: CutEdge; k: number }[] = [];
  const regions: { id: number; pixelCount: number }[] = [];
  const freeIntegers: UnwrapCandidatePayload['freeIntegers'] = [];

  // 从种子开始找第一个有效像素
  const findStart = (from: Pixel): Pixel | null => {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rr = (from[0] + r) % rows;
        const cc = (from[1] + c) % cols;
        if (valid[rr]?.[cc] && regionOf[rr]![cc] === null) return [rr, cc];
      }
    }
    return null;
  };

  let regionId = 0;
  let start = findStart(seed);
  while (start) {
    const shift = regionShifts.get(regionId) ?? 0;
    if (regionId > 0) {
      freeIntegers.push({
        region: regionId,
        shift,
        note: `区域 ${regionId} 与区域 0 不连通，整体整周数自由（整周多解）`,
      });
    }
    let count = 0;
    const queue: Pixel[] = [start];
    phase[start[0]]![start[1]] = wrapped[start[0]]![start[1]]! + shift * 2 * Math.PI;
    regionOf[start[0]]![start[1]] = regionId;
    while (queue.length > 0) {
      const cur = queue.shift()!;
      count++;
      for (const nb of neighbors(cur, rows, cols)) {
        if (!valid[nb[0]]?.[nb[1]]) continue;
        if (regionOf[nb[0]]![nb[1]] !== null) continue;
        const key = edgeKey(cur, nb);
        const isCut = cutSet.has(key);
        const grad = wrappedDiff(wrapped[cur[0]]![cur[1]]!, wrapped[nb[0]]![nb[1]]!);
        // 切口两侧整周偏移显式表示：跨切口边记录 k（默认 0，可被人工修订）
        const k = 0;
        phase[nb[0]]![nb[1]] = phase[cur[0]]![cur[1]]! + grad + k * 2 * Math.PI;
        regionOf[nb[0]]![nb[1]] = regionId;
        tree.push({ from: cur, to: nb });
        if (isCut) kOffsets.push({ edge: { a: cur, b: nb }, k });
        queue.push(nb);
      }
    }
    regions.push({ id: regionId, pixelCount: count });
    regionId++;
    start = findStart(seed);
  }

  // 候选级循环残差：展开场在每个 plaquette 上的闭合误差
  const cycleResiduals: UnwrapCandidatePayload['cycleResiduals'] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const corners: Pixel[] = [
        [r, c],
        [r, c + 1],
        [r + 1, c + 1],
        [r + 1, c],
      ];
      if (corners.some(([pr, pc]) => phase[pr]![pc] === null)) continue;
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        const [ar, ac] = corners[i]!;
        const [br, bc] = corners[(i + 1) % 4]!;
        sum += phase[br]![bc]! - phase[ar]![ac]!;
      }
      const residual = sum / (2 * Math.PI);
      if (Math.abs(residual) > 1e-9) {
        cycleResiduals.push({ plaquette: [r, c], residual });
      }
    }
  }

  return {
    seed,
    phase,
    phaseUnit: 'rad',
    kOffsets,
    tree,
    regions,
    freeIntegers,
    cycleResiduals,
  };
}

/**
 * 生成候选族：多个种子 × 不连通区域的整周平移组合。
 * 无法唯一决定时保留全部合法候选。
 */
export function generateCandidates(
  wrapped: Grid,
  valid: MaskGrid,
  cuts: CutEdge[],
  params: UnwrapParams = DEFAULT_UNWRAP_PARAMS,
): UnwrapCandidatePayload[] {
  const { rows, cols } = shape(wrapped);
  const candidates: UnwrapCandidatePayload[] = [];
  for (const seed of resolveSeeds(rows, cols)) {
    // 先跑一次确定区域数
    const probe = unwrapWithSeed(wrapped, valid, cuts, seed, new Map());
    const extraRegions = probe.regions.length - 1;
    const shifts = params.freeIntegerShifts;
    const combos: Map<number, number>[] = [new Map()];
    if (extraRegions > 0) {
      combos.length = 0;
      const build = (region: number, acc: Map<number, number>) => {
        if (region > extraRegions) {
          combos.push(new Map(acc));
          return;
        }
        for (const s of shifts) {
          acc.set(region, s);
          build(region + 1, acc);
        }
      };
      build(1, new Map());
    }
    for (const combo of combos.slice(0, 27)) {
      candidates.push(unwrapWithSeed(wrapped, valid, cuts, seed, combo));
    }
  }
  return candidates;
}
