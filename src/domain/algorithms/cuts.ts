import { Grid } from "../grid.js";
import type { CutEdge } from "../entities.js";
import type { CutEditRecord } from "../entities.js";

export interface CutInput {
  residues: Array<{ index: number; charge: 1 | -1 }>;
  blockedMask: boolean[];
  edits: CutEditRecord[];
}

export interface CutResult {
  edges: CutEdge[];
  blockedPairs: Array<[number, number]>;
  unpairedResidues: number[];
}

interface Point {
  col: number;
  row: number;
}

function manhattan(a: Point, b: Point): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

export function computeBranchCuts(grid: Grid, input: CutInput): CutResult {
  const edges: CutEdge[] = [];
  const used = new Set<number>();
  const points = new Map<number, Point>();
  const boundaryPoint = (res: Point): Point => {
    const dLeft = res.col;
    const dRight = grid.cols - 1 - res.col;
    const dTop = res.row;
    const dBottom = grid.rows - 1 - res.row;
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    if (min === dLeft) return { col: -1, row: res.row };
    if (min === dRight) return { col: grid.cols, row: res.row };
    if (min === dTop) return { col: res.col, row: -1 };
    return { col: res.col, row: grid.rows };
  };

  const positives = input.residues.filter((r) => r.charge === 1).map((r) => r.index);
  const negatives = new Set(input.residues.filter((r) => r.charge === -1).map((r) => r.index));

  for (const p of positives) {
    if (used.has(p)) continue;
    let best: number | null = null;
    let bestDist = Infinity;
    const pp = grid.coord(p);
    for (const n of negatives) {
      if (used.has(n)) continue;
      const d = manhattan(pp, grid.coord(n));
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (best !== null && bestDist <= Math.max(grid.cols, grid.rows)) {
      edges.push({ a: p, b: best, kind: "residue_pair", manual: false });
      used.add(p);
      used.add(best);
    } else {
      const bp = boundaryPoint(pp);
      const key = bp.col * 100000 + bp.row;
      points.set(key, bp);
      edges.push({ a: p, b: key, kind: "residue_boundary", manual: false });
      used.add(p);
    }
  }

  for (const n of negatives) {
    if (!used.has(n)) {
      const bp = boundaryPoint(grid.coord(n));
      const key = bp.col * 100000 + bp.row;
      edges.push({ a: n, b: key, kind: "residue_boundary", manual: false });
      used.add(n);
    }
  }

  const blockedPairs = new Set<string>();
  const addBlockedSegment = (a: number, b: number) => {
    const pa = grid.coord(a);
    const pb = Number.isInteger(b) && b >= 0 && b < grid.size ? grid.coord(b) : null;
    if (!pb) return;
    let { col, row } = pa;
    const stepCol = Math.sign(pb.col - pa.col);
    const stepRow = Math.sign(pb.row - pa.row);
    let guard = 0;
    while ((col !== pb.col || row !== pb.row) && guard++ < grid.size * 2) {
      const nextCol = col + (col !== pb.col ? stepCol : 0);
      const nextRow = row + (row !== pb.row ? stepRow : 0);
      if (grid.inBounds(nextCol, nextRow)) {
        blockedPairs.add(`${grid.index(col, row)}:${grid.index(nextCol, nextRow)}`);
      }
      col = nextCol;
      row = nextRow;
    }
  };
  for (const e of edges) if (e.kind === "residue_pair") addBlockedSegment(e.a, e.b);

  for (const edit of input.edits) {
    if (edit.action === "add" && edit.to) {
      const a = grid.index(edit.to[0], edit.to[1]);
      const from = edit.from ? grid.index(edit.from[0], edit.from[1]) : -1;
      const existing = edges.find((e) => e.a === a && e.b === from);
      if (existing) {
        existing.manual = true;
        existing.editId = edit.editId;
      } else if (from >= 0) {
        edges.push({ a, b: from, kind: "residue_pair", manual: true, editId: edit.editId });
        blockedPairs.add(`${Math.min(a, from)}:${Math.max(a, from)}`);
      }
    }
  }

  return {
    edges,
    blockedPairs: [...blockedPairs].map((s) => s.split(":").map(Number) as [number, number]),
    unpairedResidues: input.residues.map((r) => r.index).filter((i) => !used.has(i))
  };
}
