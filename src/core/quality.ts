import { bits, bitAt, f64, type GridFragment } from "./grid";
import type { QualityMapPayload } from "./types";

export const QUALITY_ALGO = { algorithmName: "snr-amplitude-quality", algorithmVersion: "1.0.0" } as const;

export interface QualityParams {
  /** 低于该振幅阈值的区域显式未知，绝不猜相位。 */
  lowAmplitudeFloor: number;
  snrFloor: number;
}

export const DEFAULT_QUALITY_PARAMS: QualityParams = { lowAmplitudeFloor: 20, snrFloor: 0.1 };

export interface QualityResult {
  payload: Omit<QualityMapPayload, "label">;
  fragmentFragments: GridFragment[];
  judgments: Array<{ at: { r: number; c: number }; reason: string }>;
}

export function computeQuality(
  phase: GridFragment,
  amplitude: GridFragment,
  snr: GridFragment,
  valid: GridFragment,
  params: QualityParams = DEFAULT_QUALITY_PARAMS,
): QualityResult {
  const { width, height } = phase;
  const q = f64(width, height, () => NaN);
  const unknown = bits(width, height, () => 0);
  const qData = q.data as number[];
  const reasons: Array<{ at: { r: number; c: number }; reason: string }> = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      const ampVal = (amplitude.data as number[])[i] as number;
      const snrVal = (snr.data as number[])[i] as number;
      const isValid = bitAt(valid, r, c) === 1;
      if (!isValid) {
        qData[i] = NaN;
        (unknown.data as string);
        reasons.push({ at: { r, c }, reason: "INVALID_MASK" });
      } else if (ampVal < params.lowAmplitudeFloor) {
        qData[i] = NaN;
        reasons.push({ at: { r, c }, reason: "LOW_AMPLITUDE_NO_GUESS" });
      } else if (snrVal < params.snrFloor) {
        qData[i] = NaN;
        reasons.push({ at: { r, c }, reason: "LOW_SNR_NO_GUESS" });
      } else {
        // 规范化仅在派生层发生；质量分 0..1。
        const ampTerm = Math.min(1, ampVal / 200);
        qData[i] = Number((0.5 * ampTerm + 0.5 * snrVal).toFixed(6));
      }
    }
  }
  const unknownWithBits = bits(width, height, (r, c) =>
    reasons.some((x) => x.at.r === r && x.at.c === c) ? 1 : 0,
  );
  return {
    payload: {
      quality: { kind: "gridFragment", fragmentId: q.fragmentId, encoding: q.encoding, width: q.width, height: q.height, digest: q.digest },
      unknownBits: { kind: "gridFragment", fragmentId: unknownWithBits.fragmentId, encoding: unknownWithBits.encoding, width: unknownWithBits.width, height: unknownWithBits.height, digest: unknownWithBits.digest },
      unknownReasons: reasons.map((x) => ({ at: x.at, reason: x.reason })),
      lowAmplitudeFloor: params.lowAmplitudeFloor,
    },
    fragmentFragments: [q, unknownWithBits],
    judgments: reasons,
  };
}
