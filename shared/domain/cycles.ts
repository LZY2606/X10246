import type {
  CycleResidual,
  ResidueCharge,
  UnwrapTreeEdge,
  WrappedPhaseInput
} from './types.js';
import { idx, TWO_PI, wrapToPi } from './geometry.js';
import { stableEdgeKey } from './residues.js';

interface SimpleGraphEdge {
  key: string;
  a: [number, number];
  b: [number, number];
}

const keyOf = (p: [number, number]) => `${p[0]},${p[1]}`;

/** 像素格点是否在闭合路径内部（射线法），用于把残差点归到环 */
function pointInPolygon(point: [number, number], poly: [number, number][]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 基本环残差：每条非树边 (a,b) 与树上唯一路径 a->b 闭合。
 * wrappedSum 为沿闭合路径的有向缠绕和；连续场应为 0，
 * |round(sum/2π)|>=1 即“循环不闭合”，且环内必然净电荷非零。
 * 切口边不参与（其两侧整周偏移显式未知），整周候选另存。
 */
export function computeCycleResiduals(
  componentId: number,
  treeId: string,
  pixels: [number, number][],
  treeEdges: UnwrapTreeEdge[],
  nonTreeEdges: SimpleGraphEdge[],
  phase: WrappedPhaseInput,
  residues: ResidueCharge[],
  width: number
): { cycles: CycleResidual[] } {
  const treeKeySet = new Set(treeEdges.map((e) => stableEdgeKey(e.a, e.b)));
  const cutKeySet = new Set<string>();
  const adj = new Map<string, [number, number][]>();
  for (const p of pixels) adj.set(keyOf(p), []);
  for (const e of treeEdges) {
    adj.get(keyOf(e.a))!.push(e.b);
    adj.get(keyOf(e.b))!.push(e.a);
  }

  const treePath = (from: [number, number], to: [number, number]): [number, number][] => {
    const prev = new Map<string, string | null>();
    prev.set(keyOf(from), null);
    const q: [number, number][] = [from];
    while (q.length) {
      const cur = q.shift()!;
      if (cur[0] === to[0] && cur[1] === to[1]) break;
      for (const n of adj.get(keyOf(cur)) ?? []) {
        if (!prev.has(keyOf(n))) {
          prev.set(keyOf(n), keyOf(cur));
          q.push(n);
        }
      }
    }
    const path: [number, number][] = [];
    let cur: string | null = keyOf(to);
    while (cur) {
      const [u, v] = cur.split(',').map(Number);
      path.push([u, v]);
      cur = prev.get(cur) ?? null;
    }
    return path.reverse();
  };

  const cycles: CycleResidual[] = [];
  let ci = 0;
  for (const ge of nonTreeEdges) {
    if (treeKeySet.has(ge.key) || cutKeySet.has(ge.key)) continue;
    const path = treePath(ge.a, ge.b);
    if (path.length < 2) continue;
    // 闭合环：树 a->b，再由非树边 b->a
    const loop: [number, number][] = [...path, ge.a];

    let sum = 0;
    for (let i = 0; i < loop.length - 1; i++) {
      const p = loop[i];
      const q = loop[i + 1];
      const isChord =
        i === loop.length - 2 &&
        ((p[0] === ge.b[0] && p[1] === ge.b[1] && q[0] === ge.a[0] && q[1] === ge.a[1]) ||
          (p[0] === ge.a[0] && p[1] === ge.a[1] && q[0] === ge.b[0] && q[1] === ge.b[1]));
      void isChord;
      sum += wrapToPi(phase.raw[idx(q[0], q[1], width)] - phase.raw[idx(p[0], p[1], width)]);
    }
    const integerResidual = Math.round(sum / TWO_PI);
    const enclosed = residues.filter((r) => pointInPolygon([r.u + 0.5, r.v + 0.5], loop));
    cycles.push({
      id: `cycle:${treeId}:${ci++}`,
      componentId,
      path: loop,
      wrappedSum: sum,
      integerResidual,
      closed: integerResidual === 0,
      enclosedResidues: enclosed
    });
  }
  return { cycles };
}
