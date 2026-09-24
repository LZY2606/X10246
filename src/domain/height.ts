import { Grid, TWO_PI } from './grid';
import { normalizeQuantity, Quantity } from './units';

/**
 * 高度转换链：展开相位 -> 标定面修正 -> 反射几何高度。
 * 链上每一步都是一等数据，携带单位与坐标基准；
 * 无法转换的值留在原位置并附诊断。
 */
export interface HeightChainStep {
  step: 'unwrapped_phase' | 'calibrated_phase' | 'surface_height';
  unit: string;
  frame: string;
  diagnostics: string[];
}

export interface HeightResult {
  chain: HeightChainStep[];
  height: Grid;           // 单位 um，基准 calibration-plane
  diagnostics: string[];
}

export interface CalibrationPlane {
  // h_cal(x,y) = a*x + b*y + c （单位 rad，基准 sensor-pixel）
  a: number; b: number; c: number;
}

export function heightFromPhase(
  unwrapped: Grid,
  wavelength: Quantity,          // 例如 { value: 632.8, unit: 'nm' }
  incidence: Quantity,           // 入射角，例如 { value: 0, unit: 'deg' }
  calibration: CalibrationPlane
): HeightResult {
  const diagnostics: string[] = [];
  const wl = normalizeQuantity(wavelength, 'length');
  const inc = normalizeQuantity(incidence, 'angle');
  if (!wl.ok) diagnostics.push(wl.diagnostic!);
  if (!inc.ok) diagnostics.push(inc.diagnostic!);

  const data: (number | null)[] = new Array(unwrapped.width * unwrapped.height).fill(null);
  if (wl.ok && inc.ok) {
    const factor = wl.value! / (2 * TWO_PI * Math.cos(inc.value!)); // 反射：h = φλ / (4π cosθ)
    for (let y = 0; y < unwrapped.height; y++) {
      for (let x = 0; x < unwrapped.width; x++) {
        const i = y * unwrapped.width + x;
        const phi = unwrapped.data[i];
        if (phi === null) continue; // 未知相位不猜高度
        const cal = calibration.a * x + calibration.b * y + calibration.c;
        data[i] = (phi - cal) * factor / 1000; // nm -> um
      }
    }
  }
  return {
    chain: [
      { step: 'unwrapped_phase', unit: 'rad', frame: 'sensor-pixel', diagnostics: [] },
      { step: 'calibrated_phase', unit: 'rad', frame: 'calibration-plane', diagnostics: [] },
      { step: 'surface_height', unit: 'um', frame: 'calibration-plane', diagnostics }
    ],
    height: { width: unwrapped.width, height: unwrapped.height, data },
    diagnostics
  };
}
