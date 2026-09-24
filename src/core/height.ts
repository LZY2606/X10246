import type {
  CalibrationPlanePayload, HeightPayload, IncidenceGeometryPayload,
  UnwrapPayload, WavelengthPayload, Grid,
} from '../shared/domain';

/**
 * 高度转换链：ψ(rad) + 2πk -> Φ(rad) -> OPD(nm) -> h_raw(nm) -> h(nm, 去标定面)。
 * 波长版本直接进入参数指纹：波长修订只使高度链过期，不影响上游。
 */
export function computeHeight(
  solution: UnwrapPayload,
  wavelength: WavelengthPayload,
  wavelengthRef: string,
  geometry: IncidenceGeometryPayload,
  calibration: CalibrationPlanePayload,
  applyCalibration: boolean,
): HeightPayload {
  const { width, height } = solution.grid;
  const factor = (geometry.doublePass ? 2 : 1) * Math.cos((geometry.incidenceAngleDeg * Math.PI) / 180);
  const sensitivity = wavelength.valueNm / (2 * Math.PI * factor); // nm/rad
  const opd = solution.grid.values.map((phi) => (Number.isFinite(phi) ? phi * wavelength.valueNm / (2 * Math.PI) : NaN));
  const rawH = opd.map((v) => (Number.isFinite(v) ? v / factor : NaN));
  const h = rawH.map((v, i) => {
    if (!Number.isFinite(v)) return NaN;
    if (!applyCalibration) return v;
    const x = i % width; const y = (i / width) | 0;
    const [a, b, c] = calibration.coefficients;
    return v - (a * x + b * y + c);
  });
  const mk = (values: number[], unit: string): Grid => ({ width, height, unit, coordFrame: 'detector-pixel', values });
  return {
    grid: mk(h, 'nm'),
    opdGrid: mk(opd, 'nm'),
    rawHeightGrid: mk(rawH, 'nm'),
    wavelengthNm: wavelength.valueNm,
    wavelengthRef,
    sensitivityNmPerRad: sensitivity,
    calibrationRemoved: applyCalibration,
    chain: ['psi_rad -> +2pi*k -> Phi_rad', 'Phi_rad -> OPD_nm = Phi*lambda/(2pi)',
      `OPD_nm -> h_raw_nm (factor=${round6(factor)})`,
      applyCalibration ? 'h_raw_nm -> h_nm = h_raw - plane(a*x+b*y+c)' : 'calibration bypassed'],
  };
}
function round6(v: number) { return Math.round(v * 1e6) / 1e6; }
