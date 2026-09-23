import { edgeKey, neighbors4, wrappedDiff } from './grid';
import type {
  CutNetwork,
  CycleCheck,
  CycleResidualReport,
  GridDatum,
  InvalidMaskFrame,
  ResidueMap,
  UnwrapTree,
  WrappedPhaseFrame,
} from '../domain/types';

export const CYCLE_ALGO_VERSION = 'cycle/v1';

/**
 * 循环残差两类：
 * 1) plaquette：全部小面元的绕环包裹差（非零即循环不闭合，指向残差点）；
 * 2) graph-cycle：对每棵展开树的每条非树边 (u,v) 回环，
 *    比较“沿树路径积分”与“直连包裹差”的整周矛盾。
 */
export function buildCycleResiduals(
  phase: WrappedPhaseFrame,
  mask: InvalidMaskFrame,
  residues: ResidueMap,
  cuts: CutNetwork,
  trees: UnwrapTree[]
): CycleResidualReport {
  const g = phase.grid;
  const cycles: CycleCheck[] = [];
  let open = 0;

  for (const r of residues.residues) {
    // 仅记录非零电荷小面元作为不闭合证据（完整 charges 已在 residue_map 中）
    const closed = false;
    open++;
    cycles.push({
      cycleId: `plaquette-${r.plaquette}`,
      kind: 'plaquette',
      pixels: plaquettePixels(g, r.i, r.j),
      residualRad: r.charge * 2 * Math.PI,
      charge: r.charge,
      closed,
      note: 'wrapped sum != 0: branch cut required',
    });
  }

  const cutSet = new Set(cuts.cuts.map((c) => edgeKey(c.a, c.b)));
  for (const tree of trees) {
    const treeEdges = new Set(tree.edges.map((e) => edgeKey(e.u, e.v)));
    const parent = new Map<number, number>();
    for (const e of tree.edges) parent.set(e.v, e.u);
    const depth = new Map<number, number>();
    depth.set(tree.root, 0);
    for (const p of tree.pathOrder) {
      const par = parent.get(p);
      if (par !== undefined) depth.set(p, (depth.get(par) ?? 0) + 1);
    }
    const inTree = new Set(tree.pathOrder);
    for (const u of tree.pathOrder) {
      for (const v of neighbors4(g, u)) {
        if (u > v) continue;
        if (!inTree.has(v)) continue;
        const key = edgeKey(u, v);
        if (treeEdges.has(key)) continue;
        if (mask.invalid[u] || mask.invalid[v]) continue;
        const direct = wrappedDiff(phase.phase[u] as number, phase.phase[v] as number);
        const pathK = pathIntegerK(tree, u, v, depth, parent);
        const mismatch = pathK + Math.round(-direct / (2 * Math.PI));
        // 被切口占据的非树边允许携带显式 jump
        const jump = cuts.cuts.find((c) => edgeKey(c.a, c.b) === key)?.jump ?? 0;
        const residual = mismatch - jump;
        const closed = residual === 0;
        if (!closed) open++;
        cycles.push({
          cycleId: `graph-${tree.treeId}-${key}`,
          kind: 'graph-cycle',
          pixels: cyclePixels(tree, u, v, parent),
          residualRad: residual * 2 * Math.PI,
          charge: residual,
          closed,
          note: cutSet.has(key)
            ? 'non-tree edge crossing explicit branch cut'
            : 'non-tree edge cycle check',
        });
      }
    }
  }

  return { grid: g, cycles, openCycleCount: open };
}

function plaquettePixels(g: GridDatum, i: number, j: number): number[] {
  return [
    j * g.width + i,
    j * g.width + i + 1,
    (j + 1) * g.width + i + 1,
    (j + 1) * g.width + i,
  ];
}

function pathIntegerK(
  tree: UnwrapTree,
  u: number,
  v: number,
  depth: Map<number, number>,
  parent: Map<number, number>
): number {
  const ku = kAt(tree, u);
  const kv = kAt(tree, v);
  void depth;
  void parent;
  return kv - ku;
}

function kAt(tree: UnwrapTree, target: number): number {
  const k = new Map<number, number>([[tree.root, 0]]);
  for (const p of tree.pathOrder) {
    if (p === tree.root) continue;
    const e = tree.edges.find((ed) => ed.v === p);
    if (e) k.set(p, (k.get(e.u) as number) + e.step);
    if (p === target) break;
  }
  return k.get(target) as number;
}

function cyclePixels(
  _tree: UnwrapTree,
  u: number,
  v: number,
  parent: Map<number, number>
): number[] {
  // u -> LCA -> v -> u 的像素闭环
  const ancU: number[] = [];
  const ancV: number[] = [];
  let a = u;
  let b = v;
  const setA = new Set<number>();
  while (true) {
    ancU.push(a);
    setA.add(a);
    const pa = parent.get(a);
    if (pa === undefined) break;
    a = pa;
  }
  while (b !== undefined && !setA.has(b)) {
    ancV.push(b);
    b = parent.get(b) as number;
  }
  const lca = b;
  return [...ancU, ...ancV.reverse(), u].filter((p, i, arr) => i === 0 || p !== arr[i - 1] || p === u || p === lca);
}
