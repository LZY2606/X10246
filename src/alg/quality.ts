import type { Grid2D, PixelStatus, QualityMap, QualityFrame, ValidityMask, AlgorithmProvenance } from '../domain/types';

/**
 * 质量图：归一化振幅质量；低振幅阈值以下的像素标记 low-amplitude-guarded，
 * 质量置 0 —— 低振幅区域绝不猜相位。
 */
export function computeQuality(
  grid: Grid2D,
  qualityFrame: QualityFrame,
  mask: ValidityMask,
  params: { lowAmplitudeThreshold: number; snrLowDb: number },
  provenance: AlgorithmProvenance
): QualityMap {
  const amps = qualityFrame.amplitude.map((c) => c.value);
  const snrs = qualityFrame.snr.map((c) => c.value);
  const finiteAmps = amps.filter((v): v is number => v !== null && Number.isFinite(v));
  const maxAmp = Math.max(1, ...finiteAmps);
  const n = grid.width * grid.height;
  const quality: number[] = new Array(n).fill(0);
  const status: PixelStatus[] = new Array(n).fill('valid');
  const diagnostics: string[] = [];

  for (let i = 0; i < n; i++) {
    if (mask.invalid[i]) {
      status[i] = 'masked';
      quality[i] = 0;
      continue;
    }
    const amp = amps[i];
    const snr = snrs[i];
    if (amp === null || !Number.isFinite(amp) || amp <= params.lowAmplitudeThreshold) {
      status[i] = 'low-amplitude-guarded';
      quality[i] = 0;
      diagnostics.push(`pixel#${i}: low-amplitude-guarded (amp=${amp === null ? 'n/a' : amp.toFixed(2)}); phase never guessed`);
      continue;
    }
    const ampQ = Math.min(1, amp / maxAmp);
    quality[i] = snr === null
      ? ampQ
      : 0.5 * ampQ + 0.5 * clamp(snr / Math.max(1, params.snrLowDb * 1.5), 0, 1);
  }
  return { kind: 'QualityMap', id: '', provenance, grid, quality, pixelStatus: status, diagnostics };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
