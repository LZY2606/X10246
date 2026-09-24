import type { DomainParams, Grid, QualityPayload } from '../shared/domain';
import { idx } from './grid';

/**
 * 质量图 = min(信噪比, 振幅归一化, 相位连续性)。
 * 低振幅或无效遮罩处质量为 0，这些像素绝不在展开时被猜测。
 */
export function computeQuality(
  wrapped: Grid, amplitude: Grid, snr: Grid, mask: Grid,
  params: DomainParams,
): QualityPayload {
  const { width, height } = wrapped;
  const out = makeQualityGrid(width, height);
  const low: number[] = [];
  let maxAmp = 0;
  for (let i = 0; i < amplitude.values.length; i++) maxAmp = Math.max(maxAmp, amplitude.values[i] ?? 0);
  if (maxAmp <= 0) maxAmp = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = idx(wrapped, x, y);
      const invalid = mask.values[i] === 1;
      const amp = amplitude.values[i] ?? 0;
      const ampNorm = amp / maxAmp;
      const sn = snr.values[i] ?? 0;
      if (invalid) { out.values[i] = 0; continue; }
      const lowAmp = ampNorm < params.lowAmplitudeThreshold || sn < params.minSn;
      if (lowAmp) { out.values[i] = 0; low.push(i); continue; }
      out.values[i] = clamp01(Math.min(ampNorm, sn));
    }
  }
  return { grid: out, lowAmplitudePixels: low };
}
function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function makeQualityGrid(width: number, height: number) {
  return { width, height, unit: '1', coordFrame: 'detector-pixel', values: new Array(width * height).fill(0) } as Grid;
}
