/**
 * 高度转换链：展开相位 → 缩放（波长/入射几何）→ 标定面修正。
 * 链上每一步都记录来源引用、单位与诊断；任何一环缺失，原始值留在原位置。
 */
import { Grid } from './grid.js';
import { Quantity, convertLength, degToRad } from './units.js';

export const HEIGHT_ALGORITHM_VERSION = 'height/1.0.0';

export interface WavelengthSpec {
  wavelength: Quantity; // 例如 { value: 632.8, unit: 'nm' }
}

export interface IncidenceGeometry {
  /** 入射角。 */
  angle: Quantity; // deg 或 rad
  /** 反射式 = 2（双程），透射式 = 1。 */
  passFactor: 1 | 2;
  frame: string;
}

export interface CalibrationPlane {
  /** z = a*x + b*y + c，单位 nm，坐标基准 frame。 */
  a: number;
  b: number;
  c: number;
  unit: 'nm';
  frame: string;
}

export interface HeightStep {
  step: 'unwrap' | 'scale' | 'calibrate';
  description: string;
  sourceRefs: Array<{ entityId: string; versionNo: number }>;
  diagnostic: string | null;
}

export interface HeightResult {
  /** 表面高度（nm）；无法转换的像素保持 null。 */
  heightNm: (number | null)[];
  steps: HeightStep[];
  diagnostics: string[];
}

export interface HeightRefs {
  unwrapRef: { entityId: string; versionNo: number };
  wavelengthRef: { entityId: string; versionNo: number };
  geometryRef: { entityId: string; versionNo: number };
  calibrationRef: { entityId: string; versionNo: number };
}

export function computeHeight(
  unwrapped: (number | null)[],
  grid: Grid,
  wavelength: WavelengthSpec,
  geometry: IncidenceGeometry,
  calibration: CalibrationPlane,
  refs: HeightRefs,
): HeightResult {
  const diagnostics: string[] = [];
  const steps: HeightStep[] = [];

  steps.push({
    step: 'unwrap',
    description: 'unwrapped-phase(rad)',
    sourceRefs: [refs.unwrapRef],
    diagnostic: null,
  });

  const wl = convertLength(wavelength.wavelength, 'nm');
  const ang = degToRad(geometry.angle);
  let scale: number | null = null;
  if (!wl.quantity) diagnostics.push(`wavelength:${wl.diagnostic}`);
  if (!ang.quantity) diagnostics.push(`geometry:${ang.diagnostic}`);
  if (wl.quantity && ang.quantity) {
    // 反射式：h = φ·λ / (2π·2·cosθ)
    scale = wl.quantity.value / (2 * Math.PI * geometry.passFactor * Math.cos(ang.quantity.value));
    if (!Number.isFinite(scale)) {
      diagnostics.push('geometry:cos(theta)=0, scale undefined');
      scale = null;
    }
  }
  steps.push({
    step: 'scale',
    description: `h = phi * lambda / (2pi * ${geometry.passFactor} * cos(theta)) [nm]`,
    sourceRefs: [refs.wavelengthRef, refs.geometryRef],
    diagnostic: scale === null ? 'scale-unavailable' : null,
  });

  steps.push({
    step: 'calibrate',
    description: `h -= (${calibration.a}*x + ${calibration.b}*y + ${calibration.c}) [${calibration.unit}@${calibration.frame}]`,
    sourceRefs: [refs.calibrationRef],
    diagnostic: null,
  });

  const heightNm: (number | null)[] = new Array(unwrapped.length).fill(null);
  for (let i = 0; i < unwrapped.length; i++) {
    const phi = unwrapped[i];
    if (phi === null || scale === null) continue; // 留在原位置，不猜
    const x = i % grid.width;
    const y = Math.floor(i / grid.width);
    heightNm[i] = phi * scale - (calibration.a * x + calibration.b * y + calibration.c);
  }

  return { heightNm, steps, diagnostics };
}
