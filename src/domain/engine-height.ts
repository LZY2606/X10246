import type {
  Grid, WavelengthSpec, IlluminationGeometry, CalibrationPlane,
  HeightChainNode, VersionRef,
} from './types';
import { TWO_PI } from './grid';

export interface HeightChainParams {
  algorithmVersion: string;
  parameterFingerprint: string;
  unwrappedRef: VersionRef;
  wavelengthRef: VersionRef;
  geometryRef: VersionRef;
  calibrationRef: VersionRef;
}

export interface HeightChainResult {
  nodes: HeightChainNode[];
  height: Grid;
}

/**
 * 高度转换链（逐节点保留，便于复核“相位→高度”每一步）：
 *  wrapped_principal -> unwrapped -> fringe_order -> optical_path -> height
 *
 *  h = (phi_u - phaseOffset) * heightPerRadian + heightOffset
 * 其中 heightPerRadian 由标定面给出；入射几何与波长以显式诊断/说明节点进入，
 * 波长版本变更只令本链与其下游过期，不触碰相位展开。
 * 无法转换的像素（unknown/NaN）留在原位置并附诊断，绝不丢弃。
 */
export function buildHeightChain(
  unwrapped: Grid,
  wavelength: WavelengthSpec,
  geometry: IlluminationGeometry,
  calibration: CalibrationPlane,
  params: HeightChainParams,
): HeightChainResult {
  const b = unwrapped.coordinateBasis;
  const n = b.rows * b.cols;
  const diagnostics: HeightChainNode['diagnostics'] = [];
  const height = new Array<number>(n).fill(NaN);
  let knownCount = 0;

  for (let p = 0; p < n; p++) {
    const phi = unwrapped.values[p];
    if (Number.isNaN(phi)) {
      diagnostics.push({ pixel: p, code: 'UNKNOWN_PHASE', message: '低振幅/无效像素：相位未知，高度保持未知，不插值' });
      continue;
    }
    const h = (phi - calibration.phaseOffset) * calibration.heightPerRadian + calibration.heightOffset;
    height[p] = Number(h.toFixed(6));
    knownCount++;
  }

  const kz = geometry.sensitivityVector.z;
  const wavelengthDiagnostic = Math.abs(kz) < 1e-9
    ? '灵敏度向量 z 分量为 0：该几何下高度不可观，所有像素应留未知'
    : `波长 ${wavelength.value} ${wavelength.unit}（来源 ${wavelength.sourceRecord}），kz=${kz}`;

  const nodes: HeightChainNode[] = [
    {
      step: 'wrapped_principal', fromRef: params.unwrappedRef,
      valueSummary: `主值相位 ${n - diagnostics.length}... 见展开面输入，单位 rad，区间 (-π,π]`,
      unit: 'rad', transformVersion: 'principal-wrap@1.0.0',
      parameterFingerprint: params.parameterFingerprint, diagnostics: [],
    },
    {
      step: 'unwrapped', fromRef: params.unwrappedRef,
      valueSummary: `沿展开树累加 2πk 后的连续相位；已知 ${knownCount}/${n} 像素`,
      unit: 'rad', transformVersion: 'tree-accumulate@1.0.0',
      parameterFingerprint: params.parameterFingerprint, diagnostics: [],
    },
    {
      step: 'fringe_order',
      valueSummary: `条纹级次 N = (φ - φ0)/2π；φ0=${calibration.phaseOffset} rad`,
      unit: 'count', transformVersion: 'fringe-order@1.0.0',
      parameterFingerprint: params.parameterFingerprint, diagnostics: [],
    },
    {
      step: 'optical_path',
      valueSummary: wavelengthDiagnostic,
      unit: 'nm', transformVersion: 'geometry-projection@1.0.0',
      parameterFingerprint: params.parameterFingerprint,
      diagnostics: Math.abs(kz) < 1e-9 ? [{ pixel: -1, code: 'UNOBSERVABLE', message: wavelengthDiagnostic }] : [],
    },
    {
      step: 'height', fromRef: params.calibrationRef,
      valueSummary: `h=(φ-${calibration.phaseOffset})*${calibration.heightPerRadian}+${calibration.heightOffset} nm/rad；标定来源 ${calibration.calibratedFrom}`,
      unit: 'nm', transformVersion: 'calibration-plane@1.0.0',
      parameterFingerprint: params.parameterFingerprint, diagnostics,
    },
  ];

  return { nodes, height: { values: height, unit: 'nm', coordinateBasis: b, encoding: 'float64' } };
}

export const TWO_PI_CONST = TWO_PI;
