import type { CalibrationPlane, IncidenceGeometry, WavelengthValue } from '../../shared/domain';

export const HEIGHT_ALGORITHM_VERSION = 'height-v1.0.0';

export interface HeightMapContent {
  width: number;
  height: number;
  unit: 'nm';
  datum: string; // 坐标基准：标定面
  wavelengthNm: number;
  thetaDeg: number;
  data: (number | null)[]; // 表面高度（nm），低振幅/遮罩处保持 null
}

// 反射式干涉：h = φ_unwrapped * λ / (4π·cosθ)，减去标定面基准。
export function heightFromPhase(
  unwrapped: (number | null)[],
  width: number,
  height: number,
  calibration: CalibrationPlane,
  wavelength: WavelengthValue,
  geometry: IncidenceGeometry,
): HeightMapContent {
  const lambdaNm = wavelength.unit === 'nm' ? wavelength.value : wavelength.value * 1000;
  const cosTheta = Math.cos((geometry.thetaDeg * Math.PI) / 180);
  const data: (number | null)[] = new Array(unwrapped.length).fill(null);
  for (let i = 0; i < unwrapped.length; i++) {
    const phi = unwrapped[i];
    if (phi === null) continue;
    const x = i % width;
    const y = Math.floor(i / width);
    const ref = calibration.a * x + calibration.b * y + calibration.c;
    data[i] = ((phi - ref) * lambdaNm) / (4 * Math.PI * cosTheta);
  }
  return {
    width,
    height,
    unit: 'nm',
    datum: calibration.frame,
    wavelengthNm: lambdaNm,
    thetaDeg: geometry.thetaDeg,
    data,
  };
}
