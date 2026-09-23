import type { Grid, MaskGrid, Pixel, QualityMapPayload } from '../shared/types.ts';
import { shape } from './grid.ts';

export const QUALITY_ALGORITHM = 'quality-map/v1';

export interface QualityParams {
  lowAmplitudeThreshold: number;
}

export const DEFAULT_QUALITY_PARAMS: QualityParams = { lowAmplitudeThreshold: 0.05 };

/**
 * 信噪评分图：由振幅与无效遮罩得到。
 * 低振幅区域标为 unknown —— 不得猜相位。
 */
export function qualityMap(
  amplitude: Grid,
  invalid: MaskGrid,
  params: QualityParams,
): QualityMapPayload {
  const { rows, cols } = shape(amplitude);
  let max = 0;
  for (const row of amplitude) for (const v of row) max = Math.max(max, Math.abs(v));
  const norm = max > 0 ? max : 1;
  const score: Grid = [];
  const unknown: MaskGrid = [];
  const holes: Pixel[] = [];
  for (let r = 0; r < rows; r++) {
    const sRow: number[] = [];
    const uRow: boolean[] = [];
    for (let c = 0; c < cols; c++) {
      const a = Math.abs(amplitude[r]![c]!) / norm;
      const isInvalid = invalid[r]?.[c] ?? false;
      const isLow = a < params.lowAmplitudeThreshold;
      sRow.push(isInvalid ? 0 : a);
      uRow.push(isInvalid || isLow);
      if (isLow && !isInvalid) holes.push([r, c]);
    }
    score.push(sRow);
    unknown.push(uRow);
  }
  return { score, unknown, holes, threshold: params.lowAmplitudeThreshold };
}
