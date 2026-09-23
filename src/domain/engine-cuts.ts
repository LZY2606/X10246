import type { Grid, CutEdit } from './types';
import { canonicalEdgeKey } from './grid';
import type { Residue } from './engine-residue';

export interface CutNetwork {
  cutEdges: Array<[number, number]>;
  dipolePairs: Array<[number, number]>;
  balanced: boolean;
}

export function edgeBetween(a: number, b: number, cols: number): [number, number] | null {
  const d = Math.abs(a - b);
  if (d === cols) return a < b ? [a, b] : [b, a];
  if (d === 1 && Math.floor(a / cols) === Math.floor(b / cols)) {
    return a < b ? [a, b] : [b, a];
  }
  return null;
}

/**
 * 支路切口（branch cuts）：
 * 1) 确定性贪心：最近邻、异号残差配成偶极子，沿 4-邻格路径放置切口；
 * 2) 剩余同号残差连到边界（不平衡场，显式 balanced=false）；
 * 3) 人工切口编辑历史追加叠加（add_cut / remove_cut），历史不可覆盖。
 * 切口两侧整周偏移不在这里“解掉”，只显式记录边，交给 offset 候选表。
 */
export function buildCutNetwork(
  phase: Grid,
  residues: Residue[],
  cutHistory: CutEdit[],
): CutNetwork {
  const b = phase.coordinateBasis;
  const cutSet = new Set<string>();
  const pairs: Array<[number, number]> = [];
  const used = new Set<number>();

  const pos = residues.filter((r) => r.charge === 1 && !used.has(r.pixel));
  const neg = residues.filter((r) => r.charge === -1);
  const options = pos
    .flatMap((pr) => neg.filter((nr) => !used.has(nr.pixel)).map((nr) => ({ pr, nr, d: manhattan(pr.pixel, nr.pixel, b.cols) })))
    .sort((a, z) => a.d - z.d);
  for (const { pr, nr } of options) {
    if (used.has(pr.pixel) || used.has(nr.pixel)) continue;
    used.add(pr.pixel); used.add(nr.pixel);
    pairs.push([pr.pixel, nr.pixel]);
    for (const e of pathEdges(pr.pixel, nr.pixel, b.cols)) cutSet.add(canonicalEdgeKey(e[0], e[1]));
  }
  const leftovers = residues.filter((r) => !used.has(r.pixel));
  for (const r of leftovers) {
    const target = nearestBoundary(r.pixel, b.rows, b.cols);
    for (const e of pathEdges(r.pixel, target, b.cols)) cutSet.add(canonicalEdgeKey(e[0], e[1]));
  }

  for (const edit of cutHistory) {
    const [u, v] = edit.edge;
    if (edgeBetween(u, v, b.cols) === null) continue;
    const k = canonicalEdgeKey(u, v);
    if (edit.action === 'add_cut') cutSet.add(k);
    if (edit.action === 'remove_cut') cutSet.delete(k);
  }

  const cutEdges = [...cutSet].map((k) => k.split('-').map(Number) as [number, number])
    .sort((a, z) => a[0] - z[0] || a[1] - z[1]);
  return { cutEdges, dipolePairs: pairs, balanced: leftovers.length === 0 };
}

function manhattan(a: number, z: number, cols: number): number {
  return Math.abs(Math.floor(a / cols) - Math.floor(z / cols)) + Math.abs((a % cols) - (z % cols));
}

/** 4-邻格 L 形路径上的边（确定性：先行后列） */
function pathEdges(a: number, z: number, cols: number): Array<[number, number]> {
  let cur = a;
  const out: Array<[number, number]> = [];
  const walk = (step: number) => {
    const nxt = cur + step;
    out.push(cur < nxt ? [cur, nxt] : [nxt, cur]);
    cur = nxt;
  };
  while (Math.floor(cur / cols) !== Math.floor(z / cols)) walk(cur < z ? cols : -cols);
  while (cur !== z) walk(cur < z ? 1 : -1);
  return out;
}

function nearestBoundary(p: number, rows: number, cols: number): number {
  const r = Math.floor(p / cols), c = p % cols;
  const dists = [r, rows - 1 - r, c, cols - 1 - c];
  const m = Math.min(...dists);
  if (m === r) return c;
  if (m === rows - 1 - r) return (rows - 1) * cols + c;
  if (m === c) return r * cols;
  return r * cols + (cols - 1);
}
