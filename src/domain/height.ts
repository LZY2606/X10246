/**
 * 高度转换链：每一步显式记录公式、输入/输出单位、波长版本。
 * 波长修订不会覆盖旧结果，而是产生新的 HeightResult（旧结果仍可查看但标记过期）。
 */
import type { InputBundle } from './vocabulary.ts';
import { convertLength } from './units.ts';
import { contentHash } from '../shared/ids.ts';
import type { HeightResult, HeightStep, UnwrapResult } from './analysis-types.ts';
import type { AnalysisParams } from './analysis-types.ts';

export function sensitivityUmPerCycle(wavelengthNm: number, incidenceDeg: number): number {
  // 双光路：OPD = 2 n h cosθ；几何高度每 cycle = λ / (2 cosθ)
  const wavelengthUm = wavelengthNm / 1000;
  return wavelengthUm / (2 * Math.cos((incidenceDeg * Math.PI) / 180));
}

export function buildHeight(
  bundle: InputBundle,
  unwrap: UnwrapResult,
  wavelengthValueNm: number,
  wavelengthVersion: string,
  params: AnalysisParams,
): HeightResult {
  const n = bundle.basis.rows * bundle.basis.cols;
  const unwrapped = unwrap.primaryUnwrappedRad;

  const opdUm = unwrapped.map((rad) => (rad === null ? null : (rad / (2 * Math.PI)) * (wavelengthValueNm / 1000)));
  const sensitivity = sensitivityUmPerCycle(wavelengthValueNm, bundle.geometry.incidenceDeg);
  const geometricUm = opdUm.map((v) => (v === null ? null : v / (2 * Math.cos((bundle.geometry.incidenceDeg * Math.PI) / 180))));

  const calRows = bundle.calibration.height.values.length === n ? bundle.calibration.height.values : new Float64Array(n).fill(0);
  let calInUm: Float64Array;
  try {
    calInUm = calRows.map((v) => convertLength(v, bundle.calibration.heightUnit, 'um')) as Float64Array;
  } catch {
    calInUm = new Float64Array(n).fill(0);
  }
  const calibratedUm = geometricUm.map((v, i) => (v === null ? null : v - (calInUm[i] ?? 0)));

  const steps: HeightStep[] = [
    {
      stepId: 'step-wrap-to-unwrap',
      stage: 'wrap-to-unwrap',
      formula: 'Φ(r,c) = wrap(φ) + 2π·k(r,c)；低振幅/遮罩像素 k=UNKNOWN',
      inputUnit: 'rad(wrapped)',
      outputUnit: 'rad',
      wavelengthVersion,
      values: unwrapped.slice(),
      note: '展开树路径积分结果；未知位置为 null，不猜相位',
    },
    {
      stepId: 'step-unwrapped-to-opd',
      stage: 'unwrapped-to-OPD',
      formula: 'OPD = Φ / 2π · λ',
      inputUnit: 'rad',
      outputUnit: 'µm',
      wavelengthVersion,
      values: opdUm.slice(),
      note: `λ = ${wavelengthValueNm} nm（${wavelengthVersion}）`,
    },
    {
      stepId: 'step-opd-to-geometric',
      stage: 'OPD-to-geometric',
      formula: 'h = OPD / (2·cos θ)',
      inputUnit: 'µm',
      outputUnit: 'µm',
      wavelengthVersion,
      values: geometricUm.slice(),
      note: `θ = ${bundle.geometry.incidenceDeg}°，方位 ${bundle.geometry.azimuthDeg}°（${bundle.geometry.rawRepresentation}）`,
    },
    {
      stepId: 'step-sensitivity',
      stage: 'sensitivity-normal-incidence',
      formula: 'K = λ / (2·cos θ)',
      inputUnit: 'nm',
      outputUnit: 'µm/cycle',
      wavelengthVersion,
      values: new Array(n).fill(sensitivity),
      note: `每整周灵敏度 K = ${sensitivity.toFixed(6)} µm/cycle；法向入射 θ=0 时 K=λ/2`,
    },
    {
      stepId: 'step-subtract-calibration',
      stage: 'subtract-calibration',
      formula: 'h_cal = h - h_ref(r,c)',
      inputUnit: 'µm',
      outputUnit: 'µm',
      wavelengthVersion,
      values: calibratedUm.slice(),
      note: `标定面：${bundle.calibration.shape}；${bundle.calibration.rawRepresentation}`,
    },
  ];

  const heightId = `height_${contentHash({
    result: unwrap.resultId,
    wavelengthValueNm,
    wavelengthVersion,
    incidenceDeg: bundle.geometry.incidenceDeg,
    calibration: bundle.calibration.rawRepresentation,
  })}`;

  return {
    heightId,
    result: unwrap,
    wavelengthValueNm,
    wavelengthVersion,
    incidenceDeg: bundle.geometry.incidenceDeg,
    sensitivityUmPerCycle: sensitivity,
    basis: bundle.basis,
    heightUnit: 'um',
    steps,
    surfaceUm: geometricUm.slice(),
    calibratedUm: calibratedUm.slice(),
    algorithm: {
      name: 'phase-to-height-chain-v1',
      version: 'alg-1.0.0',
      parameterFingerprint: `fp_${contentHash({ wavelengthValueNm, wavelengthVersion, geometry: bundle.geometry, params })}`,
    },
  };
}
