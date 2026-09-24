import { sha256 } from './hash.js';
import { idx } from './grid.js';
import { provenance, ALGORITHM_VERSIONS } from './provenance.js';
import { angleToRad } from './units.js';
import type {
  AmplitudeFrame,
  InvalidMask,
  QualityMap,
  SnrScore,
  VersionRef,
  WrappedPhasePixels,
} from './types.js';

export const QUALITY_PARAMS = {
  amplitudeWeight: 0.5,
  snrWeight: 0.5,
  lowAmplitudeThreshold: 0.15,
} as const;

/**
 * 质量图：综合振幅与信噪比。
 * 低振幅孔洞位置质量强制为 0 —— 展开器不得在这些像素猜相位。
 * 遮罩中的像素也强制为 0。
 */
export function buildQualityMap(
  phase: WrappedPhasePixels,
  amplitude: AmplitudeFrame,
  snr: SnrScore,
  mask: InvalidMask,
  sources: VersionRef[],
): QualityMap {
  const { rows, cols } = phase.basis;
  const values = new Array<number>(rows * cols);
  const ampMax = Math.max(...amplitude.values);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = idx(phase.basis, r, c);
      if (mask.values[i]) {
        values[i] = 0;
        continue;
      }
      const a = ampMax > 0 ? amplitude.values[i] / ampMax : 0;
      const s = Math.min(1, Math.max(0, snr.values[i]));
      let q = QUALITY_PARAMS.amplitudeWeight * a + QUALITY_PARAMS.snrWeight * s;
      if (a < QUALITY_PARAMS.lowAmplitudeThreshold) q = 0; // 低振幅 → 不猜
      values[i] = Math.min(1, Math.max(0, q));
    }
  }
  return {
    kind: 'qualityMap',
    basis: phase.basis,
    values,
    algorithm: provenance('buildQualityMap', ALGORITHM_VERSIONS.qualityMap, { ...QUALITY_PARAMS }),
    sources,
  };
}

/** 把包裹相位统一为弧度（派生规范化；原始数组不被改动） */
export function wrappedRad(phase: WrappedPhasePixels): number[] {
  const f = angleToRad(1, phase.unit);
  return phase.values.map((v) => (v === null || Number.isNaN(v) ? NaN : v * f));
}

export function qualityDigest(q: QualityMap): string {
  return sha256({ v: q.values, a: q.algorithm.parameterFingerprint });
}
