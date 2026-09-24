/**
 * 高度转换链：展开相位 → 光程差 → 表面高度（反射几何）→ 标定面修正。
 * 链上每一步都记录输入/输出量（带单位与坐标基准）与来源版本。
 */
import { convertToBase, type ConversionDiagnostic, type Quantity } from "./units";
import { contentDigest } from "./hash";

export const HEIGHT_ALGORITHM_VERSION = "height-chain-reflection/1.0.0";

export interface HeightChainStep {
  name: string;
  expression: string;
  output: Quantity;
}

export interface HeightChainResult {
  algorithmVersion: string;
  steps: HeightChainStep[];
  /** 每像素高度（nm，surface-normal 基准）；孔洞为 null。 */
  heightNm: Array<number | null>;
  diagnostics: ConversionDiagnostic[];
  fingerprint: string;
}

export interface HeightChainInput {
  offsets: Array<number | null>; // 每像素整周偏移
  wrapped: number[];             // rad
  wavelength: Quantity;          // 任意长度单位，派生层规范化
  incidenceAngle: Quantity;      // 任意角度单位
  calibrationFlatnessNm: number; // 标定面平面度（nm），从标定帧派生
}

export function heightChain(input: HeightChainInput): HeightChainResult {
  const diagnostics: ConversionDiagnostic[] = [];
  const steps: HeightChainStep[] = [];

  const wl = convertToBase(input.wavelength);
  if (!wl.ok) {
    diagnostics.push(wl.diagnostic);
    return { algorithmVersion: HEIGHT_ALGORITHM_VERSION, steps, heightNm: [], diagnostics, fingerprint: "" };
  }
  const ang = convertToBase(input.incidenceAngle);
  if (!ang.ok) {
    diagnostics.push(ang.diagnostic);
    return { algorithmVersion: HEIGHT_ALGORITHM_VERSION, steps, heightNm: [], diagnostics, fingerprint: "" };
  }
  const lambdaM = wl.value;
  const theta = ang.value;
  steps.push({
    name: "normalize-wavelength",
    expression: "lambda[m] = wavelength -> base",
    output: { value: lambdaM, unit: "m" },
  });
  steps.push({
    name: "normalize-incidence",
    expression: "theta[rad] = incidenceAngle -> base",
    output: { value: theta, unit: "rad", frame: "lab-frame" },
  });

  const cosT = Math.cos(theta);
  const heightNm: Array<number | null> = input.offsets.map((k, i) => {
    if (k === null) return null; // 未知状态一等数据：孔洞不猜
    const phase = input.wrapped[i]! + 2 * Math.PI * k;
    // 反射式干涉：h = lambda * phase / (4*pi*cos(theta))
    const h = (lambdaM * phase) / (4 * Math.PI * cosT);
    return (h - input.calibrationFlatnessNm * 1e-9) * 1e9;
  });
  steps.push({
    name: "phase-to-height",
    expression: "h = lambda * (wrapped + 2*pi*k) / (4*pi*cos(theta)) - calibration",
    output: { value: input.calibrationFlatnessNm, unit: "nm", frame: "surface-normal" },
  });

  return {
    algorithmVersion: HEIGHT_ALGORITHM_VERSION,
    steps,
    heightNm,
    diagnostics,
    fingerprint: contentDigest({
      algo: HEIGHT_ALGORITHM_VERSION,
      wl: lambdaM,
      theta,
      cal: input.calibrationFlatnessNm,
    }).slice(0, 16),
  };
}
