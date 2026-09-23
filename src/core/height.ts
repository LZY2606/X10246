import type {
  CalibrationSurfacePayload,
  Diagnostic,
  IncidenceGeometryPayload,
  Quantity,
  WavelengthPayload
} from './types.js';
import { normalizeQuantity } from './units.js';
import type { UnwrapResult } from './unwrap.js';

export interface HeightResult {
  /** Per-region height grids keyed by pixel index; metres. */
  heights: Array<{ regionId: number; values: Map<number, number> }>;
  /** Pixels left unknown with reason (low amplitude etc.); never filled. */
  unknown: Array<{ pixel: string; reason: Diagnostic['code'] }>;
  diagnostics: Diagnostic[];
  /** Full conversion chain values for the provenance view. */
  chain: {
    wavelength: { raw: Quantity; normalizedMetres: number | null };
    incidence: { raw: Quantity; normalizedRadians: number | null };
    sensitivityFactor: number | null;
    calibration: CalibrationSurfacePayload;
    formula: string;
  };
}

/**
 * Phase -> surface height conversion chain:
 *   height = (lambda / 4/pi factor) * phase, calibrated by the reference
 * plane. The original representations are kept on `chain`; any quantity that
 * cannot be normalized is reported instead of producing a fake height.
 */
export function convertToHeight(
  unwrap: UnwrapResult,
  cols: number,
  wavelengthPayload: WavelengthPayload,
  geometry: IncidenceGeometryPayload,
  calibration: CalibrationSurfacePayload,
  chosenOffsets: Map<number, number>
): HeightResult {
  const diagnostics: Diagnostic[] = [];
  const lambda = normalizeQuantity(wavelengthPayload.lambda, 'wavelength.lambda');
  const incidence = normalizeQuantity(geometry.incidenceAngle, 'incidenceGeometry.incidenceAngle');
  if (lambda.diagnostic) diagnostics.push(lambda.diagnostic);
  if (incidence.diagnostic) diagnostics.push(incidence.diagnostic);

  let sensitivityFactor: number | null = null;
  let formula = 'height = lambda * phi / (4*pi*cos(theta)) - plane(r,c)';
  if (lambda.value && incidence.value) {
    if (geometry.sensitivityModel === 'normal_incidence') {
      sensitivityFactor = lambda.value.value / (4 * Math.PI);
      formula = 'height = lambda * phi / (4*pi) - plane(r,c)';
    } else {
      sensitivityFactor = lambda.value.value / (4 * Math.PI * Math.cos(incidence.value.value));
    }
  }

  const heights: HeightResult['heights'] = [];
  const unknown: HeightResult['unknown'] = [];
  for (const region of unwrap.regions) {
    const values = new Map<number, number>();
    const offsetCycles = chosenOffsets.get(region.regionId);
    if (offsetCycles === undefined) {
      for (const pixel of region.treePath) {
        unknown.push({ pixel, reason: 'MULTI_VALUED_INTEGER' });
      }
      heights.push({ regionId: region.regionId, values });
      continue;
    }
    if (sensitivityFactor === null) {
      for (const pixel of region.treePath) {
        unknown.push({ pixel, reason: 'UNCONVERTIBLE_UNIT' });
      }
      heights.push({ regionId: region.regionId, values });
      continue;
    }
    for (const [pixelIndex, phi] of region.unwrapped) {
      const absolutePhase = phi + offsetCycles * 2 * Math.PI;
      const r = Math.floor(pixelIndex / cols);
      const c = pixelIndex % cols;
      const plane = calibration.plane.a * c + calibration.plane.b * r + calibration.plane.c;
      values.set(pixelIndex, sensitivityFactor * absolutePhase - plane);
    }
    heights.push({ regionId: region.regionId, values });
  }

  return {
    heights,
    unknown,
    diagnostics,
    chain: {
      wavelength: {
        raw: wavelengthPayload.lambda,
        normalizedMetres: lambda.value?.value ?? null
      },
      incidence: {
        raw: geometry.incidenceAngle,
        normalizedRadians: incidence.value?.value ?? null
      },
      sensitivityFactor,
      calibration,
      formula
    }
  };
}

