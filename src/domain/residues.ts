import type {
  Cell,
  QualityMap,
  ResidueMap,
  WrappedPhaseFrame
} from "../shared/types.ts";
import { idx, wrappedDeltaCycles } from "../shared/util.ts";

export const RESIDUE_ALGORITHM_VERSION = "residue-map-v1";

/**
 * Residue charge of every elementary 2x2 loop.
 *
 * Traversing the loop counter-clockwise
 *   (r,c) -> (r,c+1) -> (r+1,c+1) -> (r+1,c) -> (r,c)
 * the sum of wrapped gradients in cycles is either 0 or +/-1.
 * A non-zero charge means the loop cannot be integrated consistently: it is a
 * branch point, and branch cuts must pair the positive and negative charges.
 */
export function computeResidues(phase: WrappedPhaseFrame, quality: QualityMap): ResidueMap {
  const { dims } = phase;
  const cr = dims.rows - 1;
  const cc = dims.cols - 1;
  const charges = new Array<number>(cr * cc).fill(0);
  const positive: Cell[] = [];
  const negative: Cell[] = [];

  const known = (r: number, c: number): boolean => {
    const i = idx(dims, r, c);
    const tok = phase.values[i];
    return (
      tok !== undefined &&
      tok !== "." &&
      tok !== "nan" &&
      !quality.masked[i] &&
      !quality.lowAmplitude[i]
    );
  };
  const ph = (r: number, c: number): number => Number(phase.values[idx(dims, r, c)]);

  for (let r = 0; r < cr; r++) {
    for (let c = 0; c < cc; c++) {
      const cells: Array<[number, number]> = [
        [r, c],
        [r, c + 1],
        [r + 1, c + 1],
        [r + 1, c]
      ];
      const i = r * cc + c;
      if (!cells.every(([rr, rc2]) => known(rr, rc2))) {
        charges[i] = 0; // unknown corners: no charge assertion possible
        continue;
      }
      const p00 = ph(r, c);
      const p01 = ph(r, c + 1);
      const p11 = ph(r + 1, c + 1);
      const p10 = ph(r + 1, c);
      const sum =
        wrappedDeltaCycles(p00, p01) +
        wrappedDeltaCycles(p01, p11) +
        wrappedDeltaCycles(p11, p10) +
        wrappedDeltaCycles(p10, p00);
      const charge = Math.round(sum);
      charges[i] = charge;
      if (charge > 0) positive.push({ r, c });
      if (charge < 0) negative.push({ r, c });
    }
  }

  return { dims, charges, positive, negative };
}
