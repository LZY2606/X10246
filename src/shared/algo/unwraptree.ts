import { SeededRng } from '../domain/determinism';
import { edgeKey, integerStep, neighbors4, wrappedDiff } from './grid';
import type {
  CutNetwork,
  GridDatum,
  InvalidMaskFrame,
  QualityMap,
  TreeEdge,
  UnwrapTree,
  WrappedPhaseFrame,
} from '../domain/types';

export const UNWRAP_ALGO_VERSION = 'unwrap/v2';

export interface UnwrapParams {
  strategy: 'quality-guided' | 'flood-fill';
  seed: number;
}

export const DEFAULT_UNWRAP_PARAMS: UnwrapParams = { strategy: 'quality-guided', seed: 20260924 };

/** 有效像素连通分量（低振幅孔洞被遮罩排除后，可能是多连通区）。 */
export function validComponents(grid: GridDatum, mask: InvalidMaskFrame): number[][] {
  const seen = new Array<boolean>(grid.width * grid.height).fill(false);
  const comps: number[][] = [];
  for (let s = 0; s < seen.length; s++) {
    if (seen[s] || mask.invalid[s]) continue;
    const stack = [s];
    const comp: number[] = [];
    seen[s] = true;
    while (stack.length) {
      const p = stack.pop() as number;
      comp.push(p);
      for (const n of neighbors4(grid, p)) {
        if (!seen[n] && !mask.invalid[n]) {
          seen[n] = true;
          stack.push(n);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/**
 * 在每个连通分量内构造展开树：
 * - 质量引导：以分量内最高质量像素为根，优先走高质量边；
 * - flood-fill：按 BFS 稳定顺序；
 * 任何支路切口边都不允许进入树（切断残差）。
 * 输出保留完整路径与边的整周增量 step。
 */
export function buildUnwrapTrees(
  phase: WrappedPhaseFrame,
  mask: InvalidMaskFrame,
  quality: QualityMap,
  cuts: CutNetwork,
  params: UnwrapParams = DEFAULT_UNWRAP_PARAMS
): UnwrapTree[] {
  const g = phase.grid;
  const blocked = new Set(cuts.cuts.map((c) => edgeKey(c.a, c.b)));
  const rng = new SeededRng(params.seed + (params.strategy === 'flood-fill' ? 1 : 0));
  const comps = validComponents(g, mask);
  return comps.map((comp, componentId) => {
    const root =
      params.strategy === 'quality-guided'
        ? comp.reduce((best, p) => (quality.quality[p] > quality.quality[best] ? p : best), comp[0])
        : comp[0];
    const inComp = new Set(comp);
    const visited = new Set<number>([root]);
    const pathOrder: number[] = [root];
    const edges: TreeEdge[] = [];

    if (params.strategy === 'flood-fill') {
      const queue = [root];
      while (queue.length) {
        const p = queue.shift() as number;
        for (const n of neighbors4(g, p).sort((a, b) => a - b)) {
          if (!inComp.has(n) || visited.has(n) || blocked.has(edgeKey(p, n))) continue;
          visit(g, phase, edges, p, n, visited, pathOrder, queue);
        }
      }
    } else {
      const frontier = [root];
      while (frontier.length) {
        let bi = 0;
        for (let i = 1; i < frontier.length; i++) {
          if (
            quality.quality[frontier[i]] > quality.quality[frontier[bi]] + rng.next() * 1e-9 - 5e-10
          ) {
            bi = i;
          }
        }
        const p = frontier.splice(bi, 1)[0];
        for (const n of neighbors4(g, p)) {
          if (!inComp.has(n) || visited.has(n) || blocked.has(edgeKey(p, n))) continue;
          visit(g, phase, edges, p, n, visited, pathOrder, frontier);
        }
      }
    }

    return {
      treeId: `tree-c${componentId}-${params.strategy}`,
      algorithm: params.strategy,
      algoVersion: UNWRAP_ALGO_VERSION,
      root,
      pathOrder,
      edges,
      componentId,
    };
  });
}

function visit(
  g: GridDatum,
  phase: WrappedPhaseFrame,
  edges: TreeEdge[],
  p: number,
  n: number,
  visited: Set<number>,
  pathOrder: number[],
  queue: number[]
): void {
  visited.add(n);
  pathOrder.push(n);
  queue.push(n);
  const diff = wrappedDiff(phase.phase[p] as number, phase.phase[n] as number);
  void g;
  edges.push({ u: p, v: n, step: integerStep(diff) });
}

/** 沿展开树把整周数积分出来；低振幅/遮罩像素保持 null，绝不猜。 */
export function integrateK(trees: UnwrapTree[], grid: GridDatum): (number | null)[] {
  const k: (number | null)[] = new Array(grid.width * grid.height).fill(null);
  for (const tree of trees) {
    k[tree.root] = 0;
    for (const e of tree.edges) {
      k[e.v] = (k[e.u] as number) + e.step;
    }
  }
  return k;
}
