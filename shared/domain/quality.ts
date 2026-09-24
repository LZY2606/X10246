import type { AmplitudeInput, InvalidMaskInput, QualityMapPayload, WrappedPhaseInput } from './types.js';
import { idx, NEIGHBORS, inBounds, wrapToPi } from './geometry.js';

export const QUALITY_ALGO_VERSION = 'quality.v2';

export interface QualityParams {
  amplitudeThreshold: number;
  /** 相位梯度过大（接近 pi）也降权 */
  gradientPenalty: boolean;
}

export const DEFAULT_QUALITY_PARAMS: QualityParams = {
  amplitudeThreshold: 0.25,
  gradientPenalty: true
};

export function qualityFingerprint(params: QualityParams): string {
  return `amp>=${params.amplitudeThreshold.toFixed(4)};grad=${params.gradientPenalty ? 1 : 0}`;
}

/**
 * 信噪/质量评分：
 * - 无效遮罩像素：score=null，明确未知，禁止猜相位
 * - 低振幅孔洞：score=null 并标记 lowAmplitudeHole
 * - 其余：振幅归一化 × 相位连续性
 * 原始振幅保留在输入实体；此处只产出派生层。
 */
export function computeQualityMap(
  phase: WrappedPhaseInput,
  amplitude: AmplitudeInput,
  mask: InvalidMaskInput,
  params: QualityParams = DEFAULT_QUALITY_PARAMS
): QualityMapPayload {
  const { width: w, height: h } = phase;
  const score: (number | null)[] = new Array(w * h).fill(null);
  const lowHole = new Array<0 | 1>(w * h).fill(0);
  const unknownReason: (string | null)[] = new Array(w * h).fill(null);

  let ampMax = 0;
  for (const a of amplitude.raw) ampMax = Math.max(ampMax, a);

  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = idx(u, v, w);
      if (mask.valid[i] === 0) {
        score[i] = null;
        unknownReason[i] = 'invalid_mask';
        continue;
      }
      const amp = amplitude.raw[i];
      const norm = ampMax > 0 ? amp / ampMax : 0;
      if (norm < params.amplitudeThreshold) {
        score[i] = null;
        lowHole[i] = 1;
        unknownReason[i] = 'low_amplitude';
        continue;
      }
      let continuity = 1;
      if (params.gradientPenalty) {
        let bad = 0;
        let count = 0;
        for (const [du, dv] of NEIGHBORS) {
          const nu = u + du;
          const nv = v + dv;
          if (!inBounds(nu, nv, w, h)) continue;
          const ni = idx(nu, nv, w);
          if (mask.valid[ni] === 0) continue;
          if (amplitude.raw[ni] / (ampMax || 1) < params.amplitudeThreshold) continue;
          count++;
          const d = Math.abs(wrapToPi(phase.raw[ni] - phase.raw[i]));
          if (d > Math.PI * 0.8) bad++;
        }
        if (count > 0) continuity = 1 - 0.5 * (bad / count);
      }
      score[i] = Math.min(1, norm) * continuity;
    }
  }

  return {
    kind: 'quality_map',
    width: w,
    height: h,
    score,
    lowAmplitudeHole: lowHole,
    threshold: params.amplitudeThreshold,
    thresholdUnit: { kind: 'dimensionless', symbol: 'a.u.' },
    unknownReason,
    algorithmVersion: QUALITY_ALGO_VERSION,
    parameterFingerprint: qualityFingerprint(params)
  };
}
