/**
 * 高度转换链（领域计算逐步可见，不给单一最终数字）。
 *
 * 对入射照明 + 同轴观察的典型数字全息/干涉设置，单根照明方向 k_i、
 * 观察沿 +z：灵敏度向量 s = k_i - k_o。相位差 Δφ 与物点位移/高度 h 的关系：
 *     Δφ = (2π/λ) · (s · d)，  对纯法向高度 h（d = h·n̂, n̂=(0,0,1)）：
 *     h = λ · Δφ / (2π · (s·n̂))
 * 再减去标定面参考高度。无法计算（低振幅/缺波长/缺几何）保留 NaN 并附诊断。
 */
import { TWO_PI } from './units.ts';
import type { HeightStep } from './types.ts';

export const HEIGHT_ALGO_VERSION = 'height-1.0.0';

export interface HeightInputs {
  unwrapped: Float64Array; // rad，NaN=未知
  wavelengthMeters: number | null;
  sensitivityNormal: number | null; // s·n
  referenceHeightMeters: Float64Array; // 每像素标定参考（meter），NaN=无
  rows: number;
  cols: number;
}

export interface HeightResult {
  /** 每一步的中间量，供界面并排复核。 */
  steps: HeightStep[];
  opticalPath: Float64Array;
  height: Float64Array;
}

export function buildHeightChain(input: HeightInputs): HeightResult {
  const n = input.rows * input.cols;
  const opticalPath = new Float64Array(n).fill(NaN);
  const height = new Float64Array(n).fill(NaN);

  const steps: HeightStep[] = [];

  // 步骤 0：展开相位（rad）
  steps.push({
    index: 0,
    operation: 'unwrapped-phase',
    formula: 'phi_unwrap (rad)',
    inputs: [{ name: 'unwrapped', contentRef: null, unit: 'radian' }],
    outputUnit: 'radian',
    values: Array.from(input.unwrapped),
    diagnostic: null,
  });

  // 步骤 1：相位 -> 光程差 OPD = λ·Δφ/2π
  let opdDiagnostic: string | null = null;
  if (input.wavelengthMeters === null) opdDiagnostic = 'WAVELENGTH_UNCONVERTED';
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(input.unwrapped[i]) && input.wavelengthMeters !== null) {
      opticalPath[i] = (input.wavelengthMeters * input.unwrapped[i]) / TWO_PI;
    }
  }
  steps.push({
    index: 1,
    operation: 'phase-to-opd',
    formula: 'OPD = lambda * phi / (2*pi)',
    inputs: [
      { name: 'unwrapped', contentRef: null, unit: 'radian' },
      { name: 'lambda', contentRef: null, unit: 'meter' },
    ],
    outputUnit: 'meter',
    values: Array.from(opticalPath),
    diagnostic: opdDiagnostic,
  });

  // 步骤 2：OPD -> 物理高度 h = OPD / (s·n)
  let hDiagnostic: string | null = null;
  if (input.sensitivityNormal === null) hDiagnostic = 'GEOMETRY_UNCONVERTED';
  else if (Math.abs(input.sensitivityNormal) < 1e-9) hDiagnostic = 'ZERO_SENSITIVITY';
  for (let i = 0; i < n; i++) {
    if (
      Number.isFinite(opticalPath[i]) &&
      input.sensitivityNormal !== null &&
      Math.abs(input.sensitivityNormal) >= 1e-9
    ) {
      height[i] = opticalPath[i] / input.sensitivityNormal;
    }
  }
  steps.push({
    index: 2,
    operation: 'opd-to-height',
    formula: 'h = OPD / (s dot n)',
    inputs: [{ name: 'OPD', contentRef: null, unit: 'meter' }],
    outputUnit: 'meter',
    values: Array.from(height),
    diagnostic: hDiagnostic,
  });

  // 步骤 3：减去标定面参考高度
  const finalHeight = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(height[i])) {
      finalHeight[i] = Number.isFinite(input.referenceHeightMeters[i])
        ? height[i] - input.referenceHeightMeters[i]
        : height[i];
    }
  }
  steps.push({
    index: 3,
    operation: 'subtract-calibration-plane',
    formula: 'h_abs = h - h_calibration(r,c)',
    inputs: [{ name: 'calibration', contentRef: null, unit: 'meter' }],
    outputUnit: 'meter',
    values: Array.from(finalHeight),
    diagnostic: null,
  });

  return { steps, opticalPath, height: finalHeight };
}

/** 由入射方向（单位向量）与观察方向（默认 +z）计算 s·n。 */
export function sensitivityNormal(kIllum: { x: number; y: number; z: number }): number {
  const kObs = { x: 0, y: 0, z: 1 };
  return kIllum.z - kObs.z; // s = k_i - k_o 的法向分量
}
