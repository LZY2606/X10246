import type {
  CalibrationPlaneInput,
  HeightChainPayload,
  HeightChainStage,
  IlluminationGeometryInput,
  UnwrappedForestPayload,
  WavelengthInput
} from './types.js';
import { idx } from './geometry.js';

export const HEIGHT_ALGO_VERSION = 'height.chain.v2';

export interface HeightParams {
  /** 是否在灵敏度不可用时回退为正入射近似；false => 保留诊断，不猜 */
  allowNormalIncidenceFallback: boolean;
}
export const DEFAULT_HEIGHT_PARAMS: HeightParams = { allowNormalIncidenceFallback: false };
export function heightFingerprint(p: HeightParams): string {
  return `fallback=${p.allowNormalIncidenceFallback ? 1 : 0}`;
}

const RAD: HeightChainStage['unit'] = { kind: 'angle', symbol: 'rad' };
const DIMLESS: HeightChainStage['unit'] = { kind: 'dimensionless', symbol: 'fringe' };
const METER: HeightChainStage['unit'] = { kind: 'length', symbol: 'm' };
const INV_M: HeightChainStage['unit'] = { kind: 'wavenumber', symbol: '1/m' };

function norm(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}

/**
 * 高度转换链（每个像素都保留各阶段）：
 *  1 unwrapped_phase (rad)
 *  2 fringe_order = phi/2pi
 *  3 optical_path_difference = fringe_order * lambda
 *  4 sensitivity_projection：OPD / (s·n_hat)，s = obs - in（单位向量差）
 *  5 surface_height：相对标定面（标定面法向投影），保留标定残差信息
 * 任何环节缺输入或不可规范化 => 该像素高度 null，链中保留诊断，原始值不丢。
 */
export function computeHeightChain(
  forest: UnwrappedForestPayload,
  wavelength: WavelengthInput,
  geometry: IlluminationGeometryInput,
  calibration: CalibrationPlaneInput,
  params: HeightParams = DEFAULT_HEIGHT_PARAMS
): HeightChainPayload {
  const { width: w, height: h } = forest;
  const lambdaM = wavelength.unit.symbol === 'nm' ? wavelength.value * 1e-9 : wavelength.value;

  // 灵敏度向量（保留原始表示；这里做派生规范化，不回写输入）
  let sensitivity: { x: number; y: number; z: number } | null = null;
  let sensitivityDiagnostic: string | null = null;
  const inN = norm(geometry.sourceDirection);
  const obsN = norm(geometry.observerDirection);
  if (inN === 0 || obsN === 0) {
    sensitivityDiagnostic = 'zero_direction_vector：入射/观察方向为零向量，无法构造灵敏度向量';
  } else {
    const s = {
      x: geometry.observerDirection.x / obsN - geometry.sourceDirection.x / inN,
      y: geometry.observerDirection.y / obsN - geometry.sourceDirection.y / inN,
      z: geometry.observerDirection.z / obsN - geometry.sourceDirection.z / inN
    };
    sensitivity = s;
  }

  const calN = norm(calibration.normal);
  let projection = 0;
  let projectionDiagnostic: string | null = null;
  if (!sensitivity || calN === 0) {
    if (params.allowNormalIncidenceFallback && calN > 0) {
      projection = 2; // 正入射往返近似 s·n ≈ 2
    } else {
      projectionDiagnostic =
        calN === 0
          ? 'zero_calibration_normal：标定面法向为零，无法投影'
          : 'sensitivity_unavailable：灵敏度向量不可用且禁用正入射回退，高度不可转换';
    }
  } else {
    const calUnit = {
      x: calibration.normal.x / calN,
      y: calibration.normal.y / calN,
      z: calibration.normal.z / calN
    };
    projection = sensitivity.x * calUnit.x + sensitivity.y * calUnit.y + sensitivity.z * calUnit.z;
    if (Math.abs(projection) < 1e-9) {
      projectionDiagnostic = 'grazing_sensitivity：灵敏度向量与标定面平行，投影为零，高度不可转换';
    }
  }

  const chains: Record<string, HeightChainStage[]> = {};
  const heights: (number | null)[] = new Array(w * h).fill(null);

  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const i = idx(u, v, w);
      const phi = forest.unwrappedPhase[i];
      const key = `${u},${v}`;
      const stages: HeightChainStage[] = [];
      stages.push({
        id: `${key}:unwrapped_phase`,
        stage: 'unwrapped_phase',
        value: phi,
        unit: RAD,
        diagnostic: phi === null ? 'no_unwrap：低振幅/无效像素未展开，禁止猜相位' : undefined
      });
      if (phi === null) {
        pushNullChain(stages);
        chains[key] = stages;
        continue;
      }
      const fringe = phi / (2 * Math.PI);
      stages.push({ id: `${key}:fringe_order`, stage: 'fringe_order', value: fringe, unit: DIMLESS });
      const opd = fringe * lambdaM;
      stages.push({
        id: `${key}:optical_path_difference`,
        stage: 'optical_path_difference',
        value: opd,
        unit: METER
      });
      stages.push({
        id: `${key}:sensitivity_projection`,
        stage: 'sensitivity_projection',
        value: sensitivityDiagnostic || projectionDiagnostic ? null : projection,
        unit: INV_M,
        diagnostic: sensitivityDiagnostic ?? projectionDiagnostic ?? undefined
      });
      if (sensitivityDiagnostic || projectionDiagnostic) {
        stages.push({
          id: `${key}:surface_height`,
          stage: 'surface_height',
          value: null,
          unit: METER,
          diagnostic: 'height_not_convertible：保留原相位与 OPD，未为绘图丢弃'
        });
        chains[key] = stages;
        continue;
      }
      const z = opd / projection;
      stages.push({ id: `${key}:surface_height`, stage: 'surface_height', value: z, unit: METER });
      heights[i] = z;
      chains[key] = stages;
    }
  }

  return {
    kind: 'height_chain',
    width: w,
    height: h,
    chains,
    heights,
    wavelengthVersion: `${wavelength.unit.symbol}:${wavelength.value}`,
    algorithmVersion: HEIGHT_ALGO_VERSION,
    parameterFingerprint: heightFingerprint(params)
  };
}

function pushNullChain(stages: HeightChainStage[]): void {
  stages.push({
    id: 'fringe_order:null',
    stage: 'fringe_order',
    value: null,
    unit: { kind: 'dimensionless', symbol: 'fringe' },
    diagnostic: 'blocked_by_no_phase'
  });
  stages.push({
    id: 'opd:null',
    stage: 'optical_path_difference',
    value: null,
    unit: { kind: 'length', symbol: 'm' },
    diagnostic: 'blocked_by_no_phase'
  });
  stages.push({
    id: 'sensitivity:null',
    stage: 'sensitivity_projection',
    value: null,
    unit: { kind: 'wavenumber', symbol: '1/m' },
    diagnostic: 'blocked_by_no_phase'
  });
  stages.push({
    id: 'height:null',
    stage: 'surface_height',
    value: null,
    unit: { kind: 'length', symbol: 'm' },
    diagnostic: 'blocked_by_no_phase'
  });
}
