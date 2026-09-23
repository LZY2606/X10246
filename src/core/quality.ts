import type { Grid } from './grid.js';
import { idx, inBounds, wrappedDiff } from './grid.js';

/**
 * Quality score 0..1 per pixel, combining SNR and local phase consistency.
 * Invalid pixels receive quality 0 but are NOT assigned guessed phase.
 */
export function qualityMap(
  phase: Grid,
  amplitude: Grid,
  snr: Grid,
  validity: Grid,
  params: { lowAmplitudeThreshold: number }
): { quality: Float64Array; lowAmplitude: Uint8Array } {
  const { rows, cols } = phase;
  const quality = new Float64Array(rows * cols);
  const lowAmplitude = new Uint8Array(rows * cols);
  let maxAmplitude = 1e-12;
  for (let i = 0; i < amplitude.values.length; i += 1) {
    if (amplitude.values[i]! > maxAmplitude) maxAmplitude = amplitude.values[i]!;
  }
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; r += 0, c += 1) {
      const i = idx(rows, cols, r, c);
      if (phase.invalid[i] || amplitude.invalid[i] || validity.values[i] === 0 || amplitude.values[i]! <= 0) {
        quality[i] = 0;
        lowAmplitude[i] = 1;
        continue;
      }
      const ampScore = Math.min(1, amplitude.values[i]! / maxAmplitude);
      const snrScore = Math.min(1, Math.max(0, snr.values[i]! / 10));
      const consistency = localConsistency(phase, r, c);
      quality[i] = 0.4 * ampScore + 0.4 * snrScore + 0.2 * consistency;
      if (amplitude.values[i]! < params.lowAmplitudeThreshold) {
        lowAmplitude[i] = 1;
        quality[i] = Math.min(quality[i], 0.25);
      }
    }
  }
  return { quality, lowAmplitude };
}

function localConsistency(phase: Grid, r: number, c: number): number {
  const { rows, cols } = phase;
  let worst = 1;
  const here = phase.values[idx(rows, cols, r, c)]!;
  const neighbors: Array<[number, number]> = [
    [r, c + 1],
    [r + 1, c]
  ];
  for (const [nr, nc] of neighbors) {
    if (!inBounds(rows, cols, nr, nc)) continue;
    const ni = idx(rows, cols, nr, nc);
    if (phase.invalid[ni]) {
      worst = Math.min(worst, 0);
      continue;
    }
    const d = wrappedDiff(here, phase.values[ni]!);
    worst = Math.min(worst, 1 - Math.abs(d) / Math.PI);
  }
  return worst;
}

/**
 * Residue charge of the 2x2 loop whose top-left is (r,c).
 * +1 positive residue, -1 negative residue, 0 consistent.
 * Low-amplitude / invalid pixels still participate: an adjacent hole yields
 * an unknown loop that the caller must not "guess closed".
 */
export function residueMap(
  phase: Grid,
  lowAmplitude: Uint8Array
): { charge: Int8Array; unknownLoops: Uint8Array } {
  const { rows, cols } = phase;
  const charge = new Int8Array(Math.max(0, rows - 1) * Math.max(0, cols - 1));
  const unknownLoops = new Uint8Array(charge.length);
  for (let r = 0; r < rows - 1; r += 1) {
    for (let c = 0; c < cols - 1; c += 1) {
      const a = idx(rows, cols, r, c);
      const b = idx(rows, cols, r, c + 1);
      const d = idx(rows, cols, r + 1, c + 1);
      const e = idx(rows, cols, r + 1, c);
      if ([a, b, d, e].some((p) => phase.invalid[p] || lowAmplitude[p])) {
        unknownLoops[r * (cols - 1) + c] = 1;
        continue;
      }
      const sum =
        wrappedDiff(phase.values[b]!, phase.values[a]!) +
        wrappedDiff(phase.values[d]!, phase.values[b]!) +
        wrappedDiff(phase.values[e]!, phase.values[d]!) +
        wrappedDiff(phase.values[a]!, phase.values[e]!);
      const k = Math.round(sum / (2 * Math.PI));
      charge[r * (cols - 1) + c] = k === 0 ? 0 : k > 0 ? 1 : -1;
    }
  }
  return { charge, unknownLoops };
}
