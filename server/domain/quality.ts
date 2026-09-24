import type { Grid2D, MaskGrid, QualityMapPayload, Quantity, SnrScoreInput } from '../../shared/types';
import { idx, makeGrid } from './grids';

export const QUALITY_ALGORITHM = 'quality-v1';

/**
 * 质量图：信噪评分归一化；低于低振幅阈值或落在无效遮罩内的像素
 * 标记为 unknown —— 低振幅区域不得猜相位。
 */
export function computeQualityMap(
  snr: SnrScoreInput,
  mask: MaskGrid,
  threshold: Quantity,
): QualityMapPayload {
  const g = snr.grid;
  if (g.width !== mask.width || g.height !== mask.height) {
    throw new Error(`FORMAT_ERROR: snr grid ${g.width}x${g.height} 与遮罩 ${mask.width}x${mask.height} 尺寸不一致`);
  }
  let max = 0;
  for (const v of g.values) if (Number.isFinite(v) && v > max) max = v;
  const norm = max > 0 ? max : 1;
  const quality = makeGrid(g.width, g.height, (x, y) => {
    const v = g.values[idx(g, x, y)];
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v / norm)) : 0;
  }, 'dimensionless', g.datum);
  const unknownMask = new Array<boolean>(g.width * g.height).fill(false);
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const i = idx(g, x, y);
      const lowAmplitude = !(g.values[i] >= threshold.value); // NaN 也视为低振幅
      unknownMask[i] = mask.invalid[i] || lowAmplitude;
    }
  }
  return { grid: quality, unknownMask, threshold };
}
