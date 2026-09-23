import type { Grid, HeightChainStep, HeightMapPayload, Quantity, SourceRef, UnwrapCandidate } from '../shared/types.js';
import { fingerprint } from './digest.js';

export const HEIGHT_ALGORITHM_VERSION = 'height-chain/1.1.0';

const UNIT_TO_NM: Record<string, number> = { nm: 1, um: 1e3, mm: 1e6, m: 1e9 };

export interface WavelengthSpec extends Quantity { unit: string; } // nm/um/... 原始表示保留
export interface IncidentGeometry {
  incidenceAngle: Quantity; // deg 或 rad，相对标定面法线
  reflection: boolean;      // 反射式：OPD = 2h·cosθ
  frame: string;
}
export interface CalibrationSurface {
  // 参考平面 z = a*x + b*y + c（像素坐标基准）
  a: Quantity; b: Quantity; c: Quantity; // nm/pixel, nm/pixel, nm
  frame: string;
}

export interface HeightInput {
  candidate: UnwrapCandidate;
  candidateRef: SourceRef;
  wavelength: WavelengthSpec; wavelengthRef: SourceRef;
  geometry: IncidentGeometry; geometryRef: SourceRef;
  calibration: CalibrationSurface; calibrationRef: SourceRef;
  grid: Pick<Grid, 'rows' | 'cols' | 'frame'>;
}

function toNm(q: Quantity, diagnostics: string[], where: string): number | null {
  const f = UNIT_TO_NM[q.unit];
  if (f === undefined) { diagnostics.push(`无法转换：${where} 单位 '${q.unit}' 无到 nm 的换算，值 ${q.value} 留在原位置`); return null; }
  return q.value * f;
}
function toRad(q: Quantity, diagnostics: string[], where: string): number | null {
  if (q.unit === 'rad') return q.value;
  if (q.unit === 'deg') return (q.value * Math.PI) / 180;
  diagnostics.push(`无法转换：${where} 单位 '${q.unit}' 无到 rad 的换算，值 ${q.value} 留在原位置`);
  return null;
}

/** 高度转换链：相位(rad) → OPD → 高度(nm) → 标定面修正。每步记录算法版本/参数指纹/直接来源。 */
export function computeHeightMap(input: HeightInput): { payload: HeightMapPayload; paramsFingerprint: string; algorithmVersion: string } {
  const diagnostics: string[] = [];
  const chain: HeightChainStep[] = [];
  const lambdaNm = toNm(input.wavelength, diagnostics, '波长');
  const thetaRad = toRad(input.geometry.incidenceAngle, diagnostics, '入射角');
  const aNm = toNm(input.calibration.a, diagnostics, '标定面 a');
  const bNm = toNm(input.calibration.b, diagnostics, '标定面 b');
  const cNm = toNm(input.calibration.c, diagnostics, '标定面 c');

  const params = {
    wavelength: input.wavelength, geometry: input.geometry, calibration: input.calibration,
    candidateId: input.candidate.candidateId,
  };
  const paramsFingerprint = fingerprint(params);
  const { rows, cols } = input.grid;
  const heights = new Array<number>(rows * cols).fill(NaN);

  chain.push({
    step: 'phase_to_opd',
    algorithmVersion: HEIGHT_ALGORITHM_VERSION,
    paramsFingerprint,
    sources: [input.candidateRef, input.wavelengthRef],
    summary: `OPD = φ·λ/2π，λ=${input.wavelength.value} ${input.wavelength.unit}（原始表示保留）`,
  });
  chain.push({
    step: 'opd_to_height',
    algorithmVersion: HEIGHT_ALGORITHM_VERSION,
    paramsFingerprint,
    sources: [input.geometryRef],
    summary: input.geometry.reflection ? '反射几何：h = OPD/(2·cosθ)' : '透射几何：h = OPD/cosθ',
  });
  chain.push({
    step: 'calibration_subtract',
    algorithmVersion: HEIGHT_ALGORITHM_VERSION,
    paramsFingerprint,
    sources: [input.calibrationRef],
    summary: `减去标定面 z=a·x+b·y+c（基准 ${input.calibration.frame}）`,
  });

  if (lambdaNm === null || thetaRad === null || aNm === null || bNm === null || cNm === null) {
    // 无法转换：不产出高度，诊断随结果保留，绝不为了画图丢掉
    return {
      payload: { heights, unit: 'nm', frame: input.grid.frame, chain, diagnostics },
      paramsFingerprint, algorithmVersion: HEIGHT_ALGORITHM_VERSION,
    };
  }

  const divisor = input.geometry.reflection ? 2 * Math.cos(thetaRad) : Math.cos(thetaRad);
  for (let p = 0; p < rows * cols; p++) {
    const phi = input.candidate.unwrapped[p]!;
    if (!Number.isFinite(phi)) continue; // 低振幅未知像素：高度同样未知，不猜
    const r = Math.floor(p / cols), c = p % cols;
    const opd = (phi * lambdaNm) / (2 * Math.PI);
    const h = opd / divisor;
    heights[p] = h - (aNm * c + bNm * r + cNm);
  }
  return {
    payload: { heights, unit: 'nm', frame: input.grid.frame, chain, diagnostics },
    paramsFingerprint, algorithmVersion: HEIGHT_ALGORITHM_VERSION,
  };
}
