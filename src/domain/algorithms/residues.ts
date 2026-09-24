import { Grid } from "../grid.js";
import { principalDelta, TWO_PI } from "../wrapmath.js";
import type { Residue } from "../entities.js";

export interface ResidueInput {
  wrappedRadians: number[];
  invalid: boolean[];
}

export interface ResidueResult {
  residues: Residue[];
  boundaryCharge: number;
}

function valid(grid: Grid, input: ResidueInput, col: number, row: number): boolean {
  if (!grid.inBounds(col, row)) return false;
  const i = grid.index(col, row);
  return !input.invalid[i] && !Number.isNaN(input.wrappedRadians[i]);
}

export function computeResidues(grid: Grid, input: ResidueInput): ResidueResult {
  const residues: Residue[] = [];
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
      if (rounds !== 0) {
        residues.push({
          index: i00,
          charge: rounds > 0 ? 1 : -1,
          wrappedSum: s,
          masked: false
        });
      }
    }
  }

  let boundaryCharge = 0;
  for (let row = 0; row < grid.rows - 1; row++) {
    for (let col = 0; col < grid.cols - 1; col++) {
      const corners = [
        grid.index(col, row),
        grid.index(col + 1, row),
        grid.index(col + 1, row + 1),
        grid.index(col, row + 1)
      ];
      const anyInvalid = corners.some((i) => input.invalid[i] || Number.isNaN(input.wrappedRadians[i]));
      if (anyInvalid && !corners.every((i) => input.invalid[i])) {
        boundaryCharge += 1;
      }
    }
  }
  void valid;
  return { residues, boundaryCharge };
}
