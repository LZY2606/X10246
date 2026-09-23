import type {
  Cell,
  CutEditHistory,
  CutLink,
  CutNetwork,
  ResidueMap
} from "../shared/types.ts";
import { token } from "../shared/util.ts";

export const CUT_ALGORITHM_VERSION = "branch-cut-v1";

export interface CutParams {
  /** Maximum Manhattan pairing distance before a residue is left unpaired. */
  maxPairDistance: number;
}

export const DEFAULT_CUT_PARAMS: CutParams = {
  maxPairDistance: 6
};

/** Manhattan path of axis-aligned cell edges from a to b. */
function manhattanPath(a: Cell, b: Cell): Array<[Cell, Cell]> {
  const path: Array<[Cell, Cell]> = [];
  let r = a.r;
  let c = a.c;
  while (c !== b.c) {
    const nc = c + Math.sign(b.c - c);
    path.push([{ r, c }, { r, c: nc }]);
    c = nc;
  }
  while (r !== b.r) {
    const nr = r + Math.sign(b.r - r);
    path.push([{ r, c }, { r: nr, c }]);
    r = nr;
  }
  return path;
}

function edgeId(a: Cell, b: Cell): string {
  const ta = token(a);
  const tb = token(b);
  return ta < tb ? `cut|${ta}|${tb}` : `cut|${tb}|${ta}`;
}

/**
 * Pair positive and negative residue charges with a deterministic greedy
 * nearest-match, then draw branch cuts along Manhattan paths. Every cut carries
 * an explicit whole-cycle offset: oriented from the positive side to the
 * negative side it is +1. Residues that cannot be paired within range are left
 * as unpaired (multiply-connected / boundary case) and cut to the frame edge.
 */
export function computeCuts(
  residues: ResidueMap,
  history: CutEditHistory | null,
  params: CutParams = DEFAULT_CUT_PARAMS
): CutNetwork {
  const { dims } = residues;
  const byId = new Map<string, CutLink>();

  const positives = residues.positive.map((p) => ({ ...p }));
  const usedNeg = new Set<string>();
  const unpaired: Cell[] = [];

  const addCut = (a: Cell, b: Cell, offset: number, origin: CutLink["origin"]) => {
    const id = edgeId(a, b);
    if (!byId.has(id)) {
      byId.set(id, { id, a, b, cycleOffset: offset, origin });
    }
  };

  for (const pos of positives) {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const neg of residues.negative) {
      if (usedNeg.has(token(neg))) continue;
      const d = Math.abs(pos.r - neg.r) + Math.abs(pos.c - neg.c);
      if (d < bestD) {
        bestD = d;
        best = neg;
      }
    }
    if (best && bestD <= params.maxPairDistance) {
      usedNeg.add(token(best));
      // Oriented positive -> negative: explicit +1 cycle jump.
      for (const [a, b] of manhattanPath(pos, best)) addCut(a, b, 1, "residue_pairing");
    } else {
      unpaired.push(pos);
      // Cut to the nearest frame edge (multiply-connected boundary support).
      const target = boundaryTarget(pos, dims);
      for (const [a, b] of manhattanPath(pos, target)) addCut(a, b, 1, "residue_pairing");
    }
  }
  for (const neg of residues.negative) {
    if (!usedNeg.has(token(neg))) {
      unpaired.push(neg);
      const target = boundaryTarget(neg, dims);
      for (const [a, b] of manhattanPath(neg, target)) addCut(a, b, -1, "residue_pairing");
    }
  }

  // Operator cut-edit history is overlaid last: places add explicit offsets,
  // removes delete a cut. Edits are the raw history; the result is derived.
  if (history) {
    for (const edit of history.edits) {
      const { a, b } = edit.edge;
      const id = edgeId(a, b);
      if (edit.action === "remove") {
        byId.delete(id);
      } else {
        byId.set(id, {
          id,
          a,
          b,
          cycleOffset: edit.cycleOffset ?? 1,
          origin: "operator_edit"
        });
      }
    }
  }

  return {
    dims,
    cuts: [...byId.values()].sort((x, y) => x.id.localeCompare(y.id)),
    unpairedResidues: unpaired.sort((x, y) => token(x).localeCompare(token(y)))
  };
}

function boundaryTarget(cell: Cell, dims: { rows: number; cols: number }): Cell {
  const up = cell.r;
  const down = dims.rows - 1 - cell.r;
  const left = cell.c;
  const right = dims.cols - 1 - cell.c;
  const min = Math.min(up, down, left, right);
  if (min === up) return { r: 0, c: cell.c };
  if (min === down) return { r: dims.rows - 1, c: cell.c };
  if (min === left) return { r: cell.r, c: 0 };
  return { r: cell.r, c: dims.cols - 1 };
}
