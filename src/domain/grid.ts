import type { GraphEdge } from "../shared/types.ts";

export interface Cell {
  row: number;
  col: number;
}

export const key = (r: number, c: number): string => `${r}:${c}`;
export const parseKey = (k: string): Cell => {
  const [r, c] = k.split(":").map(Number);
  return { row: r!, col: c! };
};

export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0]
];

export function sameCell(a: Cell, b: Cell): boolean {
  return a.row === b.row && a.col === b.col;
}

export function edgeKey(e: GraphEdge): string {
  return [e.r1, e.c1, e.r2, e.c2].join(",");
}

export function normalizeEdge(e: GraphEdge): GraphEdge {
  const a = key(e.r1, e.c1);
  const b = key(e.r2, e.c2);
  return a <= b ? e : { r1: e.r2, c1: e.c2, r2: e.r1, c2: e.c1 };
}

export function inBounds(r: number, c: number, rows: number, cols: number): boolean {
  return r >= 0 && c >= 0 && r < rows && c < cols;
}

/** 包裹差：Δw = wrap(w_b - w_a) ∈ [-π,π) */
export function wrapDiff(a: number, b: number): number {
  let d = b - a;
  while (d >= Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function wrapToRange(x: number): number {
  let y = x % (2 * Math.PI);
  if (y >= Math.PI) y -= 2 * Math.PI;
  if (y < -Math.PI) y += 2 * Math.PI;
  return y;
}

/** 两个已知像素之间的整周数（b 相对 a）：Δw - (w_b - w_a) 的舍入 */
export function wrapCountBetween(wa: number, wb: number): number {
  return Math.round((wrapDiff(wa, wb) - (wb - wa)) / (2 * Math.PI));
}

export function neighbors4(r: number, c: number): Cell[] {
  return DIRS.map(([dr, dc]) => ({ row: r + dr, col: c + dc }));
}

export interface ValidGrid {
  rows: number;
  cols: number;
  valid: boolean[][];
}

export function cellsOf(g: ValidGrid): Cell[] {
  const out: Cell[] = [];
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) if (g.valid[r]![c]) out.push({ row: r, col: c });
  return out;
}

export function adjacentCells(g: ValidGrid, r: number, c: number): Cell[] {
  return neighbors4(r, c).filter((n) => inBounds(n.row, n.col, g.rows, g.cols) && g.valid[n.row]![n.col]);
}

/** 被禁用边集合阻断的连通区域划分（禁用边即切口） */
export function floodRegions(g: ValidGrid, blocked: Set<string>): { regionId: string; cells: Cell[] }[] {
  const seen = new Set<string>();
  const regions: { regionId: string; cells: Cell[] }[] = [];
  const all = cellsOf(g);
  for (const start of all) {
    const sk = key(start.row, start.col);
    if (seen.has(sk)) continue;
    const q: Cell[] = [start];
    seen.add(sk);
    const cells: Cell[] = [];
    while (q.length) {
      const cur = q.shift()!;
      cells.push(cur);
      for (const n of adjacentCells(g, cur.row, cur.col)) {
        const e = normalizeEdge({ r1: cur.row, c1: cur.col, r2: n.row, c2: n.col });
        if (blocked.has(edgeKey(e))) continue;
        const nk = key(n.row, n.col);
        if (!seen.has(nk)) {
          seen.add(nk);
          q.push(n);
        }
      }
    }
    regions.push({ regionId: `R${regions.length}`, cells: sortCells(cells) });
  }
  return regions;
}

export function sortCells(cells: Cell[]): Cell[] {
  return [...cells].sort((a, b) => a.row - b.row || a.col - b.col);
}

export function cellRegionMap(regions: { regionId: string; cells: Cell[] }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const reg of regions) for (const cell of reg.cells) m.set(key(cell.row, cell.col), reg.regionId);
  return m;
}

/** 已知像素之间、跨越一个有效-无效邻居关系的链接（孔洞/切口的边界表达） */
export interface BoundaryLink {
  linkId: string;
  edge: GraphEdge;
  a: Cell;
  b: Cell;
  kind: "cut" | "gap";
}

/** 列出所有连接两个已知像素、但被视为“非树可自由裁定”的链接 */
export function boundaryLinks(
  g: ValidGrid,
  cutEdges: Set<string>,
  regionOf: Map<string, string>
): BoundaryLink[] {
  const out: BoundaryLink[] = [];
  let idx = 0;
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      if (!g.valid[r]![c]) continue;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc, g.rows, g.cols) || !g.valid[nr]![nc]) continue;
        const e = normalizeEdge({ r1: r, c1: c, r2: nr, c2: nc });
        const ek = edgeKey(e);
        const a = { row: e.r1, col: e.c1 };
        const b = { row: e.r2, col: e.c2 };
        const sameRegion = regionOf.get(key(e.r1, e.c1)) === regionOf.get(key(e.r2, e.c2));
        if (cutEdges.has(ek)) {
          out.push({ linkId: `L${idx++}`, edge: e, a, b, kind: "cut" });
        } else if (!sameRegion) {
          out.push({ linkId: `L${idx++}`, edge: e, a, b, kind: "gap" });
        }
      }
    }
  }
  return dedupeLinks(out);
}

export function dedupeLinks(links: BoundaryLink[]): BoundaryLink[] {
  const seen = new Set<string>();
  return links.filter((l) => {
    const k = edgeKey(l.edge) + "|" + l.kind;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
