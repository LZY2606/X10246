import type {
  GridDatum,
  InvalidMaskFrame,
  QualityMap,
  SignalQualityFrame,
} from '../domain/types';

export const QUALITY_ALGO_VERSION = 'quality/v1';
export const QUALITY_FORMULA =
  'quality = clamp(normalize(amplitude),0,1)*0.5 + clamp(snrDb/30,0,1)*0.5';

export interface QualityParams {
  minAmplitude: number;
  minSnrDb: number;
}

export const DEFAULT_QUALITY_PARAMS: QualityParams = {
  minAmplitude: 0.25,
  minSnrDb: 6,
};

/**
 * 质量图只从振幅与信噪比派生；低振幅孔洞不在此处“猜”成可用像素，
 * invalid 像素的质量记 0。
 */
export function buildQualityMap(
  grid: GridDatum,
  quality: SignalQualityFrame,
  mask: InvalidMaskFrame,
  params: QualityParams = DEFAULT_QUALITY_PARAMS
): QualityMap {
  const values: number[] = [];
  let maxAmp = 0;
  for (const a of quality.amplitude) if (a !== null && a > maxAmp) maxAmp = a;
  if (maxAmp === 0) maxAmp = 1;
  for (let p = 0; p < grid.width * grid.height; p++) {
    if (mask.invalid[p] || quality.amplitude[p] === null || quality.snrDb[p] === null) {
      values.push(0);
      continue;
    }
    const ampTerm = Math.min(1, Math.max(0, (quality.amplitude[p] as number) / maxAmp));
    const snrTerm = Math.min(1, Math.max(0, (quality.snrDb[p] as number) / 30));
    values.push(ampTerm * 0.5 + snrTerm * 0.5);
  }
  return {
    grid,
    quality: values,
    formula: QUALITY_FORMULA,
    thresholds: { ...params },
  };
}

/** 低振幅判定：振幅/信噪比低于门限即视为不可信（与遮罩求并）。 */
export function lowAmplitudePixels(
  quality: SignalQualityFrame,
  mask: InvalidMaskFrame,
  params: QualityParams = DEFAULT_QUALITY_PARAMS
): number[] {
  const out: number[] = [];
  for (let p = 0; p < quality.amplitude.length; p++) {
    const a = quality.amplitude[p];
    const s = quality.snrDb[p];
    if (
      mask.invalid[p] ||
      a === null ||
      s === null ||
      a < params.minAmplitude ||
      s < params.minSnrDb
    ) {
      out.push(p);
    }
  }
  return out;
}
