import { Grid } from "../grid.js";
import { principalDelta } from "../wrapmath.js";
import type { QualityCell } from "../entities.js";

export interface QualityInput {
  wrappedRadians: number[];
  amplitudes: number[];
  scores: number[];
  invalid: boolean[];
  lowAmplitudeThreshold: number;
}

export interface QualityResult {
  cells: QualityCell[];
  componentCount: number;
}

export function computeQualityMap(grid: Grid, input: QualityInput): QualityResult {
  const variance = new Array<number>(grid.size).fill(0);
  for (let i = 0; i < grid.size; i++) {
    if (input.invalid[i] || Number.isNaN(input.wrappedRadians[i]!)) continue;
    const deltas: number[] = [];
    for (const n of grid.neighbors(i)) {
      if (!input.invalid[n.index] && !Number.isNaN(input.wrappedRadians[n.index]!)) {
        deltas.push(Math.abs(principalDelta(input.wrappedRadians[i]!, input.wrappedRadians[n.index]!)));
      }
    }
    if (deltas.length) {
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      variance[i] = deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length;
    }
  }

  let maxAmp = 1e-12;
  for (const a of input.amplitudes) if (!Number.isNaN(a)) maxAmp = Math.max(maxAmp, a);
  let maxSnr = 1e-12;
  for (const s of input.scores) if (!Number.isNaN(s)) maxSnr = Math.max(maxSnr, s);

  const usable = (i: number) =>
    !input.invalid[i] &&
    !Number.isNaN(input.wrappedRadians[i]) &&
    !Number.isNaN(input.amplitudes[i]) &&
    input.amplitudes[i]! >= input.lowAmplitudeThreshold;

  const component = new Array<number>(grid.size).fill(-1);
  let componentCount = 0;
  for (let start = 0; start < grid.size; start++) {
    if (!usable(start) || component[start] !== -1) continue;
    const id = componentCount++;
    const stack = [start];
    component[start] = id;
    while (stack.length) {
      const cur = stack.pop()!;
      for (const n of grid.neighbors(cur)) {
        if (usable(n.index) && component[n.index] === -1) {
          component[n.index] = id;
          stack.push(n.index);
        }
      }
    }
  }

  const cells: QualityCell[] = [];
  for (let i = 0; i < grid.size; i++) {
    const lowAmplitude =
      Number.isNaN(input.amplitudes[i]) || input.amplitudes[i]! < input.lowAmplitudeThreshold;
    const ampNorm = Number.isNaN(input.amplitudes[i]) ? 0 : input.amplitudes[i]! / maxAmp;
    const snrNorm = Number.isNaN(input.scores[i]) ? 0 : Math.max(0, input.scores[i]!) / maxSnr;
    const pdv = 1 / (1 + 4 * variance[i]!);
    const quality = usable(i) ? 0.5 * ampNorm + 0.3 * snrNorm + 0.2 * pdv : 0;
    cells.push({
      index: i,
      quality,
      lowAmplitude,
      invalid: !!input.invalid[i] || Number.isNaN(input.wrappedRadians[i]),
      component: component[i]
    });
  }
  return { cells, componentCount };
}
