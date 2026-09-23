import type { CutEdge, CycleResidual, Grid, UnwrapCandidate } from '../shared/types.js';
import { fingerprint } from './digest.js';

export const UNWRAP_ALGORITHM_VERSION = 'unwrap-tree-cuts/1.2.0';
const TWO_PI = Math.PI * 2;

export function wrapToPi(x: number): number {
  let v = (x + Math.PI) % TWO_PI;
  if (v < 0) v += TWO_PI;
  return v - Math.PI;
}

export interface UnwrapParams {
  lowAmplitudeThreshold: number; // 低于此信噪评分 = 低振幅区域，不得猜相位
  maxComponentOffsetSearch: number; // 整周多解搜索范围（±k）
  treeStrategies: TreeStrategy[]; // 不同展开树 -> 局部一致的多候选
}
export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = {
  lowAmplitudeThreshold: 0.2,
  maxComponentOffsetSearch: 1,
  treeStrategies: ['bfs-quality', 'dfs-row'],
};
export type TreeStrategy = 'bfs-quality' | 'dfs-row';

export interface UnwrapInput {
  wrappedPhase: Grid;  // rad, [-π, π)
  snrScore: Grid;      // 1, [0,1]
  invalidMask: Grid;   // 1 = 无效
}

export interface UnwrapResult {
  candidates: UnwrapCandidate[];
  cutEdges: CutEdge[];      // 首个候选的切口网络（共享结构）
  residuals: CycleResidual[]; // 循环残差（与树无关的拓扑判断 + 树相关路径）
  components: number[];     // 每像素分量号，-1 = 非有效像素
  validMask: boolean[];
  paramsFingerprint: string;
  algorithmVersion: string;
  diagnostics: string[];
}

function neighbors(p: number, rows: number, cols: number): number[] {
  const r = Math.floor(p / cols), c = p % cols;
  const out: number[] = [];
  if (r > 0) out.push(p - cols);
  if (r + 1 < rows) out.push(p + cols);
  if (c > 0) out.push(p - 1);
  if (c + 1 < cols) out.push(p + 1);
  return out;
}

function edgeKey(a: number, b: number): string { return a < b ? `${a}:${b}` : `${b}:${a}`; }

/** 构建一棵展开树并沿树累积解缠值；返回非树边（切口候选）。 */
function buildTree(
  comp: number[], phi: number[], valid: boolean[], rows: number, cols: number, strategy: TreeStrategy,
): { unwrapped: Map<number, number>; nonTreeEdges: [number, number][] } {
  const inComp = new Set(comp);
  const seed = strategy === 'bfs-quality' ? comp[0]! : comp[comp.length - 1]!;
  const unwrapped = new Map<number, number>();
  unwrapped.set(seed, phi[seed]!);
  const nonTreeEdges: [number, number][] = [];
  const seenEdge = new Set<string>();
  // 栈/队列元素：[pixel, 已访问邻居数]
  if (strategy === 'bfs-quality') {
    const queue = [seed];
    while (queue.length) {
      const p = queue.shift()!;
      for (const q of neighbors(p, rows, cols)) {
        if (!valid[q] || !inComp.has(q)) continue;
        const k = edgeKey(p, q);
        if (unwrapped.has(q)) {
          if (!seenEdge.has(k)) { seenEdge.add(k); nonTreeEdges.push([p, q]); }
          continue;
        }
        seenEdge.add(k);
        unwrapped.set(q, unwrapped.get(p)! + wrapToPi(phi[q]! - phi[p]!));
        queue.push(q);
      }
    }
  } else {
    const stack = [seed];
    while (stack.length) {
      const p = stack.pop()!;
      for (const q of neighbors(p, rows, cols)) {
        if (!valid[q] || !inComp.has(q)) continue;
        const k = edgeKey(p, q);
        if (unwrapped.has(q)) {
          if (!seenEdge.has(k)) { seenEdge.add(k); nonTreeEdges.push([p, q]); }
          continue;
        }
        seenEdge.add(k);
        unwrapped.set(q, unwrapped.get(p)! + wrapToPi(phi[q]! - phi[p]!));
        stack.push(q);
      }
    }
  }
  return { unwrapped, nonTreeEdges };
}

/** 用树路径求基本循环残差：path(a→b) 的树累积 + 边(a,b) 梯度，折合整周。 */
function cycleResidual(
  a: number, b: number, phi: number[], unwrapped: Map<number, number>,
): number {
  const treeDelta = unwrapped.get(b)! - unwrapped.get(a)!; // 沿树的累积差
  const edgeGrad = wrapToPi(phi[b]! - phi[a]!);
  const loop = treeDelta - edgeGrad; // 理论上应为 2πk
  return Math.round(loop / TWO_PI);
}

export function runUnwrap(input: UnwrapInput, params: UnwrapParams = DEFAULT_UNWRAP_PARAMS): UnwrapResult {
  const { rows, cols } = input.wrappedPhase;
  const phi = input.wrappedPhase.data;
  const diagnostics: string[] = [];
  if (input.snrScore.rows !== rows || input.snrScore.cols !== cols
    || input.invalidMask.rows !== rows || input.invalidMask.cols !== cols) {
    throw new Error('网格尺寸不一致：原相位像素/信噪评分/无效遮罩必须同形');
  }

  // 低振幅区域不得猜相位：低信噪像素与遮罩像素一样不参与展开，保持未知
  const valid: boolean[] = [];
  const unknownPixels: number[] = [];
  for (let p = 0; p < rows * cols; p++) {
    const masked = input.invalidMask.data[p] === 1;
    const lowAmp = (input.snrScore.data[p] ?? 0) < params.lowAmplitudeThreshold;
    const ok = !masked && !lowAmp && Number.isFinite(phi[p]!);
    valid.push(ok);
    if (!ok && !masked) unknownPixels.push(p); // 低振幅：留在原位置，标未知
    if (masked) unknownPixels.push(p);
  }

  // 连通分量（多连通区分别展开）
  const components = new Array<number>(rows * cols).fill(-1);
  const compLists: number[][] = [];
  for (let p = 0; p < rows * cols; p++) {
    if (!valid[p] || components[p] !== -1) continue;
    const idx = compLists.length;
    const list: number[] = [];
    const queue = [p];
    components[p] = idx;
    while (queue.length) {
      const u = queue.shift()!;
      list.push(u);
      for (const q of neighbors(u, rows, cols)) {
        if (valid[q] && components[q] === -1) { components[q] = idx; queue.push(q); }
      }
    }
    // bfs-quality 用分量内最高信噪像素做种子
    list.sort((x, y) => (input.snrScore.data[y] ?? 0) - (input.snrScore.data[x] ?? 0));
    compLists.push(list);
  }
  if (compLists.length > 1) {
    diagnostics.push(`多连通区：${compLists.length} 个分量，分量间相对整周偏移不可由数据唯一决定`);
  }

  // 每种展开树策略生成一个候选；不同展开树可得到局部一致解
  const candidates: UnwrapCandidate[] = [];
  let sharedCuts: CutEdge[] = [];
  let sharedResiduals: CycleResidual[] = [];
  for (const strategy of params.treeStrategies) {
    const perCompUnwrapped: Map<number, number>[] = [];
    const cutEdges: CutEdge[] = [];
    const residuals: CycleResidual[] = [];
    let cycleIdx = 0;
    let consistent = true;
    compLists.forEach((comp, ci) => {
      const { unwrapped, nonTreeEdges } = buildTree(comp, phi, valid, rows, cols, strategy);
      perCompUnwrapped.push(unwrapped);
      for (const [a, b] of nonTreeEdges) {
        const grad = wrapToPi(phi[b]! - phi[a]!);
        const k = cycleResidual(a, b, phi, unwrapped);
        // 切口边：两侧整周偏移显式表示
        cutEdges.push({ a, b, gradRad: grad, offsetCycles: k });
        const res: CycleResidual = {
          cycleId: `cyc_${strategy}_${ci}_${cycleIdx++}`,
          path: [a, b],
          residualCycles: k,
          status: k === 0 ? 'closed' : 'open',
        };
        residuals.push(res);
        if (k !== 0) {
          consistent = false;
          diagnostics.push(`循环不闭合：${res.cycleId} 残差 ${k} 整周（路径 ${a}→${b}）`);
        }
      }
    });
    if (strategy === params.treeStrategies[0]) { sharedCuts = cutEdges; sharedResiduals = residuals; }

    // 整周多解：多分量时枚举分量间相对整周偏移的全部合法候选
    const offsetsList: Record<number, number>[] = [{}];
    if (compLists.length > 1) {
      offsetsList.length = 0;
      const range = params.maxComponentOffsetSearch;
      const extra = compLists.length - 1;
      const combos = Math.pow(2 * range + 1, extra);
      for (let combo = 0; combo < combos; combo++) {
        const offsets: Record<number, number> = { 0: 0 };
        let v = combo;
        for (let ci = 1; ci < compLists.length; ci++) {
          offsets[ci] = (v % (2 * range + 1)) - range;
          v = Math.floor(v / (2 * range + 1));
        }
        offsetsList.push(offsets);
      }
      if (combos > 1) diagnostics.push(`整周多解：${combos} 个合法候选（分量相对偏移 ±${range} 内均无法排除）`);
    }

    for (const offsets of offsetsList) {
      const unwrappedArr = new Array<number>(rows * cols).fill(NaN);
      compLists.forEach((comp, ci) => {
        const base = offsets[ci]! * TWO_PI;
        for (const p of comp) unwrappedArr[p] = perCompUnwrapped[ci]!.get(p)! + base;
      });
      candidates.push({
        candidateId: `cand_${strategy}_${Object.values(offsets).join('_')}`,
        treeSpec: `tree:${strategy};seed:highest-snr;components:${compLists.length}`,
        componentOffsets: offsets,
        unknownPixels: [...unknownPixels],
        unwrapped: unwrappedArr,
        cutEdges,
        residuals,
        locallyConsistent: consistent,
        status: 'proposed',
      });
    }
  }

  return {
    candidates,
    cutEdges: sharedCuts,
    residuals: sharedResiduals,
    components,
    validMask: valid,
    paramsFingerprint: fingerprint(params),
    algorithmVersion: UNWRAP_ALGORITHM_VERSION,
    diagnostics,
  };
}
