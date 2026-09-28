import type {
  AmplitudeLayer,
  InvalidMaskLayer,
  QualityMap,
  SnrScoreLayer,
} from '../shared/model.js';

/**
 * 质量图：综合信噪评分与振幅，遮罩像素记 0。
 * 低振幅阈值以下像素会在展开层被标记 unknown（不猜相位）。
 */
export interface QualityOptions {
  amplitudeFloor: number;
  weightSnr: number;
  weightAmp: number;
}

export const DEFAULT_QUALITY: QualityOptions = {
  amplitudeFloor: 0.2,
  weightSnr: 0.6,
  weightAmp: 0.4,
};

export function maxAmplitude(amp: AmplitudeLayer): number {
  let m = 0;
  for (const v of amp.values) if (Number.isFinite(v) && v > m) m = v;
  return m;
}

export function buildQuality(
  amp: AmplitudeLayer,
  snr: SnrScoreLayer,
  mask: InvalidMaskLayer,
  opts: QualityOptions = DEFAULT_QUALITY,
): { quality: QualityMap; lowAmplitude: boolean[] } {
  const n = amp.values.length;
  const values = new Array<number>(n);
  const lowAmplitude = new Array<boolean>(n);
  const peak = maxAmplitude(amp) || 1;
  for (let i = 0; i < n; i++) {
    const ampNorm = clamp01(amp.values[i] / peak);
    const snrNorm = clamp01(snr.values[i] ?? 0);
    lowAmplitude[i] = ampNorm < opts.amplitudeFloor;
    if (mask.values[i]) {
      values[i] = 0;
    } else {
      values[i] = clamp01(
        opts.weightSnr * snrNorm + opts.weightAmp * ampNorm,
      );
    }
  }
  return {
    quality: { kind: 'quality-map', values, contributors: ['amplitude', 'snr', 'mask'] },
    lowAmplitude,
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
