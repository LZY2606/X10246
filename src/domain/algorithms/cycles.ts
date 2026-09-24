import { Grid } from "../grid.js";
import { principalDelta, TWO_PI } from "../wrapmath.js";
import type { CycleResidual, TreeEdge } from "../entities.js";

export interface CycleInput {
  wrappedRadians: number[];
  invalid: boolean[];
  residuePlaquettes: Set<number>;
  blockedPairs: ReadonlySet<string>;
  trees: Array<{
    strategy: "quality_flood" | "shortest_jump_mst";
    edges: TreeEdge[];
  }>;
}

const pairKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;

export function computeCycles(grid: Grid, input: CycleInput): CycleResidual[] {
  const cycles: CycleResidual[] = [];

  // 1) Every valid 2x2 plaquette: closed loop on the wrapped-phase lattice.
  let n = 0;
  for (let row = 0; row < grid.rows - 1; row++) {
    for (let col = 0; col < grid.cols - 1; col++) {
      const i00 = grid.index(col, row);
      const i10 = grid.index(col + 1, row);
      const i11 = grid.index(col + 1, row + 1);
      const i01 = grid.index(col, row + 1);
      const corners = [i00, i10, i11, i01];
      if (corners.some((i) => input.invalid[i] || Number.isNaN(input.wrappedRadians[i]))) continue;
      const s =
        principalDelta(input.wrappedRadians[i10]!, input.wrappedRadians[i00]!) +
        principalDelta(input.wrappedRadians[i11]!, input.wrappedRadians[i10]!) +
        principalDelta(input.wrappedRadians[i01]!, input.wrappedRadians[i11]!) +
        principalDelta(input.wrappedRadians[i00]!, input.wrappedRadians[i01]!);
      const rounds = Math.round(s / TWO_PI);
      const crossesCut =
        input.blockedPairs.has(pairKey(i00, i10)) ||
        input.blockedPairs.has(pairKey(i10, i11)) ||
        input.blockedPairs.has(pairKey(i11, i01)) ||
        input.blockedPairs.has(pairKey(i01, i00));
      const status =
        rounds !== 0
          ? "misclosure_around_residue"
          : crossesCut
            ? "misclosure_local"
            : "closed";
      for (const tree of input.trees) {
        cycles.push({
          cycleId: `cyc_${tree.strategy}_p${n.toString().padStart(4, "0")}`,
          pixelLoop: corners,
          wrapResidual: s,
          status: crossesCut && rounds === 0 ? "closed" : status,
          crossesCut,
          enclosesResidues: rounds !== 0 ? [i00] : [],
          treeStrategy: tree.strategy,
          path: plaquettePath(corners)
        });
      }
      n++;
    }
  }

  // 2) Loops that hug mask holes: any unknown adjacent to a valid loop -> misclosure_local / unknown.
  for (let i = 0; i < grid.size; i++) {
    if (!input.invalid[i]) continue;
    const validNeighbors = grid.neighbors(i).filter((nb) => !input.invalid[nb.index]);
    if (validNeighbors.length >= 3) {
      const loop = validNeighbors.map((v) => v.index);
      for (const tree of input.trees) {
        const s = loop.reduce((acc, cur, idx) => {
          const nxt = loop[(idx + 1) % loop.length]!;
          return acc + principalDelta(input.wrappedRadians[nxt]!, input.wrappedRadians[cur]!);
        }, 0);
        const rounds = Math.round(s / TWO_PI);
        cycles.push({
          cycleId: `cyc_${tree.strategy}_hole${i}`,
          pixelLoop: loop,
          wrapResidual: s,
          status: rounds !== 0 ? "misclosure_local" : "unknown",
          crossesCut: false,
          enclosesResidues: rounds !== 0 ? [i] : [],
          treeStrategy: tree.strategy,
          path: loop.map((cur, idx) => {
            const nxt = loop[(idx + 1) % loop.length]!;
            return {
              from: cur,
              to: nxt,
              increment: principalDelta(input.wrappedRadians[nxt]!, input.wrappedRadians[cur]!)
            };
          })
        });
      }
    }
  }

  return cycles;
}

function plaquettePath(corners: number[]) {
  return corners.map((cur, idx) => {
    const nxt = corners[(idx + 1) % corners.length]!;
    return { from: cur, to: nxt, increment: 0 };
  });
}
