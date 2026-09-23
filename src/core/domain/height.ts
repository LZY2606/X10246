import { ALGORITHM_VERSIONS } from "../../shared/constants.js";
import type {
  HeightFieldPayload,
  HeightPixel,
  IncidenceGeometryPayload,
  UnwrappedPhasePayload,
  VersionRef,
  WavelengthPayload,
} from "../../shared/types.js";
import { idx } from "./grid.js";

/**
 * 高度转换链（每一步保留来源版本）：
 *   sensitivity_factor = lambda_nm / (2*pi*passFactor)
 *   height_nm = unwrapped_phase(rad) * sensitivity_factor
 * 波长版本切换只会使依赖该波长版本的高度结果过期。
 */
export function buildHeightField(args: {
  unwrapped: UnwrappedPhasePayload;
  wavelength: WavelengthPayload;
  geometry: IncidenceGeometryPayload;
  wavelengthRef: VersionRef;
  geometryRef: VersionRef;
  calibrationRef?: VersionRef;
}): HeightFieldPayload {
  const { unwrapped, wavelength, geometry, wavelengthRef, geometryRef, calibrationRef } = args;
  const w = unwrapped.width;
  const h = unwrapped.height;
  const lambda = wavelength.wavelength.value;
  const passFactor = geometry.passFactor;
  const sensitivityFactor = lambda / (Math.PI * 2 * passFactor);
  const unit = wavelength.wavelength.unit.unit;
  const pixels: HeightPixel[] = [];
  for (const p of unwrapped.pixels) {
    if (p.unwrappedRad === null) {
      pixels.push({ x: p.x, y: p.y, height: null, conversionTrace: null, unknownReason: p.unknownReason ?? "phase_unknown" });
      continue;
    }
    pixels.push({
      x: p.x,
      y: p.y,
      height: Math.round(p.unwrappedRad * sensitivityFactor * 1e6) / 1e6,
      conversionTrace: {
        unwrappedRadRef: `cand_${p.x}_${p.y}_tree`,
        sensitivityFactor,
        wavelengthVersion: wavelengthRef.objectId,
        wavelengthVersionNo: wavelengthRef.version,
        geometryVersion: geometryRef.objectId,
        geometryVersionNo: geometryRef.version,
        calibrationVersion: calibrationRef?.objectId,
        calibrationVersionNo: calibrationRef?.version,
      },
    });
  }
  void idx;
  return {
    width: w,
    height: h,
    unit,
    pixels,
    conversionFormula: `height_${unit} = unwrapped_rad * lambda(${lambda}${unit}) / (2*pi*passFactor(${passFactor}))`,
    algorithmVersion: ALGORITHM_VERSIONS.height,
  };
}

/** 斜入射的灵敏度修正（保留几何版本）；当前用 cos(theta) 近似因子。 */
export function obliqueFactor(geometry: IncidenceGeometryPayload): number {
  if (geometry.arrangement !== "oblique_incidence" || !geometry.incidenceAngle) return 1;
  const theta = (geometry.incidenceAngle.value * Math.PI) / 180;
  return 1 / Math.cos(theta);
}
