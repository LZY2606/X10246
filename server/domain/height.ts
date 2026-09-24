import type {
  CalibrationSurfaceInput, Grid2D, HeightMapPayload,
  IncidentGeometryInput, UnwrapCandidatePayload, WavelengthInput,
} from '../../shared/types';
import { idx, TWO_PI } from './grids';

export const HEIGHT_ALGORITHM = 'height-v1';

/**
 * 高度转换链：h = (phi_unwrapped - phi_ref) * lambda / (2*pi*(reflection?2:1)*cos(theta))
 * 再减去标定面。所有量携带单位；无法转换的像素留在原位并附诊断。
 */
export function computeHeightMap(
  candidate: UnwrapCandidatePayload,
  wavelength: WavelengthInput,
  geometry: IncidentGeometryInput,
  calibration: CalibrationSurfaceInput,
): HeightMapPayload {
  const g = candidate.unwrapped;
  if (wavelength.wavelength.unit !== 'nm') {
    throw new Error(`UNIT_ERROR: 波长单位 ${wavelength.wavelength.unit} 无法转换为 nm，保留原始表示`);
  }
  if (geometry.incidenceAngle.unit !== 'deg') {
    throw new Error(`UNIT_ERROR: 入射角单位 ${geometry.incidenceAngle.unit} 无法转换为 deg`);
  }
  const lambdaUm = wavelength.wavelength.value / 1000; // nm -> um
  const theta = (geometry.incidenceAngle.value * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const factor = lambdaUm / (TWO_PI * (geometry.reflection ? 2 : 1) * (Math.abs(cosT) > 1e-9 ? cosT : 1));
  const cal = calibration.grid;
  const sameSize = cal.width === g.width && cal.height === g.height;
  const unconvertible: HeightMapPayload['unconvertible'] = [];
  const values = g.values.map((phi, i) => {
    if (Number.isNaN(phi)) return Number.NaN;
    const x = i % g.width, y = Math.floor(i / g.width);
    if (!sameSize) { unconvertible.push({ x, y, reason: '标定面尺寸与相位网格不一致，保留原始相位' }); return Number.NaN; }
    const ref = cal.values[idx(cal, x, y)];
    if (!Number.isFinite(ref)) { unconvertible.push({ x, y, reason: '标定面该像素无有效值' }); return Number.NaN; }
    return phi * factor - ref;
  });
  return {
    grid: { width: g.width, height: g.height, values, unit: 'um', datum: 'pixel-grid' },
    formula: `h = phi * ${lambdaUm}um / (2pi * ${geometry.reflection ? 2 : 1} * cos(${geometry.incidenceAngle.value}deg)) - calibration`,
    wavelength: wavelength.wavelength,
    incidenceAngle: geometry.incidenceAngle,
    unconvertible,
  };
}
