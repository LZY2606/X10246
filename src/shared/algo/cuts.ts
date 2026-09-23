import { SeededRng } from '../domain/determinism';
import { edgeKey, idx, xy } from './grid';
import type {
  CutEdge,
  CutEditHistory,
  CutNetwork,
  GridDatum,
  InvalidMaskFrame,
  ResidueMap,
} from '../domain/types';

export const CUT_ALGO_VERSION = 'cut/v1';

export interface CutParams {
  maxPairRadius: number;
  seed: number;
}

export const DEFAULT_CUT_PARAMS: CutParams = { maxPairRadius: 6, seed: 20260924 };

/**
 * Goldstein 支路切口的最小确定化版本：
 * - 异号残差按距离贪心配对，切口沿像素边连接它们最近的顶点；
 * - 落单残差连接到最近边界（to-border）；
 * - 人工切口编辑历史随后叠加，任何重复切口都保留其人工来源与显式 jump。
 * 切口两侧整周偏移 jump 永远显式存储（默认 +1，人工可改）。
 */
export function buildCutNetwork(
  grid: GridDatum,
  residues: ResidueMap,
  mask: InvalidMaskFrame,
  manual: CutEditHistory,
  params: CutParams = DEFAULT_CUT_PARAMS
): CutNetwork {
  const rng = new SeededRng(params.seed);
  const log: string[] = [];
  const edges: CutEdge[] = [];
  const seen = new Set<string>();

  const addCut = (a: number, b: number, jump: number, source: CutEdge['source'], weight: number) => {
    const key = edgeKey(a, b);
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      cutEdgeId: `cut-${edges.length.toString().padStart(3, '0')}`,
      a,
      b,
      jump,
      source,
      weight,
    });
  };

  const points = residues.residues.map((r) => ({
    x: r.i,
    y: r.j,
    charge: r.charge,
    used: false,
  }));

  for (let t = 0; t < points.length; t++) {
    const p = points[t];
    if (p.used) continue;
    let best = -1;
    let bestD = Infinity;
    for (let u = t + 1; u < points.length; u++) {
      const q = points[u];
      if (q.used || q.charge === p.charge) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y) + rng.next() * 1e-6;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    const pV = idx(grid, p.x, p.y);
    if (best >= 0 && bestD <= params.maxPairRadius) {
      const q = points[best];
      const qV = idx(grid, q.x, q.y);
      q.used = true;
      p.used = true;
      connectAlongGrid(grid, pV, qV, (a, b) => addCut(a, b, 1, 'residue-pairing', bestD));
      log.push(`pair (${p.x},${p.y})${p.charge} <-> (${q.x},${q.y})${q.charge} d=${bestD.toFixed(2)}`);
    } else {
      p.used = true;
      const border = nearestBorderVertex(grid, pV);
      connectAlongGrid(grid, pV, border, (a, b) =>
        addCut(a, b, 1, 'to-border', params.maxPairRadius)
      );
      log.push(`residue (${p.x},${p.y})${p.charge} -> border`);
    }
  }

  for (const edit of manual.edits) {
    const key = edgeKey(edit.a, edit.b);
    if (edit.action === 'add') {
      if (seen.has(key)) {
        log.push(`manual add ${key} skipped: cut already exists`);
      } else {
        seen.add(key);
        edges.push({
          cutEdgeId: `cut-${edges.length.toString().padStart(3, '0')}`,
          a: edit.a,
          b: edit.b,
          jump: 1,
          source: 'manual',
          weight: 0,
        });
        log.push(`manual add ${key} (${edit.reason})`);
      }
    } else {
      const at = edges.findIndex((e) => edgeKey(e.a, e.b) === key);
      if (at >= 0) {
        edges.splice(at, 1);
        log.push(`manual remove ${key} (${edit.reason})`);
      }
    }
  }

  // 重新赋予稳定身份，保证导出/导入后顺序与身份一致
  const reordered = edges.map((e, i) => ({
    ...e,
    cutEdgeId: `cut-${i.toString().padStart(3, '0')}`,
  }));
  void mask;
  return { grid, cuts: reordered, pairingLog: log };
}

function connectAlongGrid(
  g: GridDatum,
  from: number,
  to: number,
  emit: (a: number, b: number) => void
): void {
  let cur = from;
  const guard = new Set<number>([cur]);
  let steps = 0;
  while (cur !== to && steps++ < g.width * g.height) {
    const a = xy(g, cur);
    const b = xy(g, to);
    const nx = a.x === b.x ? a.x : a.x + Math.sign(b.x - a.x);
    const ny = a.x === b.x ? a.y + Math.sign(b.y - a.y) : a.y;
    const next = idx(g, nx, ny);
    if (!guard.has(next)) {
      emit(cur, next);
      guard.add(next);
    }
    cur = next;
  }
}

function nearestBorderVertex(g: GridDatum, p: number): number {
  const { x, y } = xy(g, p);
  const options = [
    { p: idx(g, 0, y), d: x },
    { p: idx(g, g.width - 1, y), d: g.width - 1 - x },
    { p: idx(g, x, 0), d: y },
    { p: idx(g, x, g.height - 1), d: g.height - 1 - y },
  ].sort((a, b) => a.d - b.d);
  return options[0].p;
}
