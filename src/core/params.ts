import { canonicalJson } from './identity.js';
import type { QualityOptions } from './quality.js';

/** 算法版本与参数指纹：每个派生值都带算法版本、参数指纹与直接来源。 */
export const ALGO_VERSION = 'unwrap-1.0.0';
export const HEIGHT_ALGO_VERSION = 'height-1.0.0';

export interface AnalysisParams {
  quality: QualityOptions;
  /** 是否允许跨切口推断（false=切口两侧只保留候选不直接解） */
  neverGuessAcrossCuts: boolean;
}

export const DEFAULT_PARAMS: AnalysisParams = {
  quality: { amplitudeFloor: 0.2, weightSnr: 0.6, weightAmp: 0.4 },
  neverGuessAcrossCuts: true,
};

export function paramFingerprint(params: AnalysisParams): string {
  return 'fp:' + canonicalJson(params);
}
