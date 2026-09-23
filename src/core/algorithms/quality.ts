import type { PhaseGrid, QualityMap } from "../types.ts";

// 质量图：融合振幅与 SNR 的 [0,1] 分数，并独立标记“禁止猜测”单元。
// 低振幅孔洞内绝不补相位：表面高度链在这些单元保持 null。

export const QUALITY_ALGORITHM_VERSION = "quality-amplitude-snr-1.0";

export interface QualityParams {
  amplitudeThreshold: number;
  snrThreshold: number;
}

export const DEFAULT_QUALITY_PARAMS: QualityParams = {
  amplitudeThreshold: 0.25,
  snrThreshold: 0.3,
};

export function buildQualityMap(grid: PhaseGrid, params: QualityParams): QualityMap {
  const n = grid.rows * grid.cols;
  const quality = new Array<number>(n);
  const doNotGuess = new Array<boolean>(n);

  let ampMax = 1e-12;
  for (let i = 0; i < n; i++) ampMax = Math.max(ampMax, grid.amplitude[i] || 0);

  for (let i = 0; i < n; i++) {
    if (grid.invalidMask[i]) {
      quality[i] = 0;
      doNotGuess[i] = true;
      continue;
    }
    const normAmp = Math.max(0, Math.min(1, (grid.amplitude[i] || 0) / ampMax));
    const snr = Math.max(0, Math.min(1, grid.snr[i] || 0));
    quality[i] = 0.6 * normAmp + 0.4 * snr;
    const lowAmp = (grid.amplitude[i] ?? 0) < params.amplitudeThreshold * ampMax;
    const lowSnr = (grid.snr[i] ?? 0) < params.snrThreshold;
    // 振幅或信噪比过低：不得猜相位（但区别于硬无效遮罩，仍可作为“可见的不可信区”）
    doNotGuess[i] = lowAmp || lowSnr;
  }

  return {
    quality,
    doNotGuess,
    amplitudeThreshold: params.amplitudeThreshold,
    snrThreshold: params.snrThreshold,
    algorithmVersion: QUALITY_ALGORITHM_VERSION,
  };
}
