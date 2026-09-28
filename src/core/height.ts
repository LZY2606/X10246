import type {
  CalibrationPlane,
  HeightChain,
  IncidenceGeometry,
  UnwrapTree,
  WavelengthSpec,
} from '../shared/model.js';
import { angleToRad, lengthToMeters } from '../shared/units.js';

/**
 * 高度转换链：unwrapped phase -> 光程差(OPD) -> 表面高度。
 * 垂直入射： OPD = phi ；h = OPD * lambda / (4 pi * n)。
 * 离轴照明： h = phi * sensitivityFactor（几何显式给出，米/弧度）。
 *
 * 无法转换（未知像素、缺标定的像素尺度）保留 null 与诊断，绝不丢值。
 */
export function heightChain(
  chainId: string,
  tree: UnwrapTree,
  wavelength: WavelengthSpec,
  geometry: IncidenceGeometry,
  calibration: CalibrationPlane,
): HeightChain {
  const nPixels = tree.pixels.values.length;
  const heightMeters = new Array<number | null>(nPixels).fill(null);
  const diagnostics: HeightChain['diagnostics'] = [];

  const wl = lengthToMeters(wavelength.value, wavelength.unit);
  if (!wl.ok) {
    diagnostics.push({ index: -1, code: wl.diagnostic.code, message: wl.diagnostic.message });
  }
  const wavelengthM = wl.ok ? wl.meters : null;
  const incRad = angleToRad(geometry.incidenceAngle, geometry.angleUnit);
  const sensitivity =
    geometry.model === "tilted-illumination"
      ? geometry.sensitivityFactorMetersPerRad ?? null
      : wavelengthM !== null
        ? wavelengthM / (4 * Math.PI * wavelength.refractiveIndex)
        : null;

  for (let i = 0; i < nPixels; i++) {
    const p = tree.pixels.values[i];
    if (p.status !== 'valid') {
      diagnostics.push({
        index: i,
        code: 'UNKNOWN_PHASE_NO_HEIGHT',
        message: `相位未知（${p.reason}），高度保留 null，不做猜测`,
      });
      continue;
    }
    if (sensitivity === null || !Number.isFinite(sensitivity)) {
      diagnostics.push({
        index: i,
        code: 'NO_SENSITIVITY',
        message: '缺少波长/几何灵敏度，无法换算高度',
      });
      continue;
    }
    const relativeM = p.unwrappedRad * sensitivity;
    heightMeters[i] = calibration.referenceHeightM + relativeM;
  }

  // 离轴角度也作为基准显式记录（诊断里保留，便于复查）
  if (geometry.model === 'normal-incidence' && Math.abs(incRad) > 1e-9) {
    diagnostics.push({
      index: -1,
      code: 'INCIDENCE_ANGLE_IGNORED',
      message: '模型声明垂直入射但入射角非零，请核对入射几何版本',
    });
  }

  return {
    chainId,
    wavelengthId: wavelength.wavelengthId,
    geometryId: geometry.geometryId,
    calibrationId: calibration.calibrationId,
    heightMeters,
    diagnostics,
  };
}
