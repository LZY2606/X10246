import type {
  AmplitudeFrame,
  InvalidityMask,
  QualityMap,
  WrappedPhaseFrame
} from "../shared/types.ts";
import { idx } from "../shared/util.ts";

export const QUALITY_ALGORITHM_VERSION = "quality-map-v1";

export interface QualityParams {
  /** Amplitudes below this value (in frame units) mark pixels that must stay unknown. */
  lowAmplitudeThreshold: number;
}

export const DEFAULT_QUALITY_PARAMS: QualityParams = {
  lowAmplitudeThreshold: 0.25
};

/**
 * Reliability/SNR score per pixel.
 *
 * Rule (low-amplitude pixels are never guessed):
 *  - masked or missing phase/amplitude -> score 0, masked=true
 *  - amplitude below threshold -> score 0, lowAmplitude=true (phase unknown)
 *  - otherwise score is normalised amplitude, mildly rewarded for spatial
 *    consistency with the strongest neighbour.
 */
export function computeQuality(
  phase: WrappedPhaseFrame,
  amplitude: AmplitudeFrame,
  mask: InvalidityMask,
  params: QualityParams = DEFAULT_QUALITY_PARAMS
): QualityMap {
  const { dims } = phase;
  const n = dims.rows * dims.cols;
  const amps = new Array<number | null>(n);
  for (let i = 0; i < n; i++) {
    const tok = amplitude.values[i];
    amps[i] = tok === undefined || tok === "." || tok === "nan" ? null : Number(tok);
  }

  let max = 0;
  for (const a of amps) if (a !== null && a > max) max = a;

  const scores = new Array<number>(n).fill(0);
  const lowAmplitude = new Array<boolean>(n).fill(false);
  const masked = new Array<boolean>(n).fill(false);

  for (let r = 0; r < dims.rows; r++) {
    for (let c = 0; c < dims.cols; c++) {
      const i = idx(dims, r, c);
      const phaseTok = phase.values[i];
      const amp = amps[i];
      const isMasked = mask.values[i] === 1;
      const phaseMissing = phaseTok === "." || phaseTok === "nan" || phaseTok === undefined;
      if (isMasked || phaseMissing || amp === null) {
        masked[i] = true;
        scores[i] = 0;
        continue;
      }
      if (amp < params.lowAmplitudeThreshold) {
        lowAmplitude[i] = true;
        scores[i] = 0;
        continue;
      }
      // Spatial consistency reward: compare wrapped phase with best neighbour.
      let best = 0.5;
      const neigh: Array<[number, number]> = [
        [r - 1, c],
        [r + 1, c],
        [r, c - 1],
        [r, c + 1]
      ];
      for (const [nr, nc] of neigh) {
        if (nr < 0 || nc < 0 || nr >= dims.rows || nc >= dims.cols) continue;
        const ni = idx(dims, nr, nc);
        const nTok = phase.values[ni];
        const nAmp = amps[ni];
        if (mask.values[ni] === 1 || nTok === "." || nTok === "nan" || nAmp === null) continue;
        const d = Math.abs(angleDiff(Number(phaseTok), Number(nTok)));
        const consistency = Math.max(0, 1 - d / Math.PI);
        if (consistency > best) best = consistency;
      }
      const normAmp = max > 0 ? amp / max : 0;
      scores[i] = clamp01(0.8 * normAmp + 0.2 * best);
    }
  }

  return { dims, scores, lowAmplitude, masked, threshold: params.lowAmplitudeThreshold };
}

function angleDiff(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d <= -Math.PI) d += 2 * Math.PI;
  if (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
