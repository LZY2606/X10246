import { Grid } from "../grid.js";
import type { HeightCell } from "../entities.js";

export interface HeightInput {
  unwrappedRadians: number[];
  unknownIndices: number[];
  sensitivityFactor: number;
  wavelengthM: number | null;
  planeHeightM: (index: number) => number;
  pixelCoords: (index: number) => { xM: number; yM: number };
}

export function computeHeightChain(grid: Grid, input: HeightInput): HeightCell[] {
  const unknown = new Set(input.unknownIndices);
  const cells: HeightCell[] = [];
  for (let i = 0; i < grid.size; i++) {
    if (unknown.has(i) || Number.isNaN(input.unwrappedRadians[i]) || input.wavelengthM === null) {
      cells.push({
        index: i,
        phaseUnwrappedRad: Number.isNaN(input.unwrappedRadians[i]) ? null : input.unwrappedRadians[i],
        calibratedHeightM: null,
        unknown: true,
        diagnostic:
          input.wavelengthM === null
            ? "wavelength not convertible; raw wavelength retained in place, height not computed"
            : "low-amplitude / invalid / cut-separated pixel: phase never guessed"
      });
      continue;
    }
    const phaseDelta = input.unwrappedRadians[i]!;
    const optical = (phaseDelta / (2 * Math.PI)) * input.wavelengthM * input.sensitivityFactor;
    const { xM, yM } = input.pixelCoords(i);
    void xM;
    void yM;
    const calibrated = optical - input.planeHeightM(i);
    cells.push({
      index: i,
      phaseUnwrappedRad: phaseDelta,
      calibratedHeightM: calibrated,
      unknown: false,
      diagnostic: null
    });
  }
  return cells;
}
