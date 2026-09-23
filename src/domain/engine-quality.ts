import type { Grid } from './types';
import { neighbors4, wrappedDiff, decodeMask } from './grid';

export interface QualityResult {
  quality: Grid;
  lowAmplitudePixels: number[];
}

/**
 * 质量图：结合信噪评分与局部相位二阶差分（可靠度）。
 * 低振幅孔洞像素：质量为 0 且列入黑名单 —— 低振幅区域不得猜相位。
 * 返回质量格网（dimensionless，0..1）。
 */
export function computeQuality(phase: Grid, snr: Grid, mask: Grid, lowThreshold = 5): QualityResult {
  const b = phase.coordinateBasis;
  const cells = decodeMask(mask);
  const n = b.rows * b.cols;
  const values = new Array<number>(n).fill(0);
  const low: number[] = [];
  for (let p = 0; p < n; p++) {
    if (cells[p] !== 'valid') {
      values[p] = 0;
      if (cells[p] === 'low_amplitude_hole') low.push(p);
      continue;
    }
    const ns = neighbors4(p, b).filter((q) => cells[q] === 'valid');
    let secondDiff = 0;
    if (ns.length >= 2) {
      const d = ns.map((q) => wrappedDiff(phase.values[p], phase.values[q]));
      const mean = d.reduce((a, x) => a + x, 0) / d.length;
      secondDiff = d.reduce((a, x) => a + (x - mean) ** 2, 0) / d.length;
    }
    const snrNorm = Math.max(0, Math.min(1, (snr.values[p] - lowThreshold) / 25));
    const reliability = 1 / (1 + 8 * secondDiff);
    const q = Math.max(0, Math.min(1, snrNorm * reliability));
    values[p] = Number(q.toFixed(6));
    if (snr.values[p] < lowThreshold) low.push(p);
  }
  return { quality: { values, unit: 'dimensionless', coordinateBasis: b, encoding: 'float64' }, lowAmplitudePixels: [...new Set(low)].sort((a, z) => a - z) };
}
