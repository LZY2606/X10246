import type { AmplitudeFrame, InvalidMask, QualityScores, WrappedPhaseFrame } from "../shared/types";

/**
 * 质量图：优先采用导入的信噪评分；缺失时由振幅归一化派生。
 * 无效遮罩覆盖的像素质量为 0，且在后续任何环节都保持“未知”，绝不猜相位。
 */
export function buildQualityMap(
  phase: WrappedPhaseFrame,
  amplitude: AmplitudeFrame | null,
  quality: QualityScores | null,
  mask: InvalidMask
): { score: (number | null)[]; source: "imported" | "amplitude" | "none" } {
  const n = phase.rows * phase.cols;
  const out: (number | null)[] = new Array(n).fill(null);
  let source: "imported" | "amplitude" | "none" = "none";

  if (quality) {
    source = "imported";
    for (let i = 0; i < n; i++) {
      const s = quality.score[i];
      out[i] = typeof s === "number" && !Number.isNaN(s) ? clamp01(s) : null;
    }
  } else if (amplitude) {
    source = "amplitude";
    let max = 0;
    for (const a of amplitude.amplitude) if (a !== null && Number.isFinite(a) && a > max) max = a;
    for (let i = 0; i < n; i++) {
      const a = amplitude.amplitude[i];
      out[i] = a !== null && Number.isFinite(a) && max > 0 ? clamp01(a / max) : null;
    }
  }

  for (let i = 0; i < n; i++) {
    if (phase.phaseRad[i] === null || phase.phaseRad[i] === undefined) out[i] = null;
    if (mask.invalid[i]) out[i] = null;
  }
  return { score: out, source };
}

/** 低振幅阈值判定：质量分（导入或振幅归一化）低于阈值即低振幅 */
export function isLowAmplitude(score: (number | null)[], i: number, threshold: number): boolean {
  const s = score[i];
  return s === null || s < threshold;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
