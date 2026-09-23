import { xy } from './grid';
import type {
  CalibrationPlane,
  HeightField,
  HeightPixelChain,
  IlluminationGeometry,
  IntegerCandidate,
  WavelengthSpec,
  WrappedPhaseFrame,
} from '../domain/types';

export const HEIGHT_ALGO_VERSION = 'height/v1';
export const HEIGHT_FORMULA =
  'h = lambda * (phi + 2*pi*k) / (2*pi*(cos(theta_i)+cos(theta_o))) + (a*x+b*y+c)_cal';

export interface HeightParams {
  coordinateUnit: string;
}

/**
 * 高度转换链逐像素保留：
 * wrappedRad -> k -> unwrappedRad -> fringeOrder -> sensitivity ->
 * relativeHeight -> planeAdjustment -> calibratedHeight。
 * 波长或角度无法解析时，对应派生量留 null 并在 sensitivityFactor 上附诊断，
 * 原始量仍保留在波长/几何实体中，不丢值、不臆造。
 */
export function buildHeightField(
  phase: WrappedPhaseFrame,
  wavelength: WavelengthSpec | null,
  geometry: IlluminationGeometry | null,
  calibration: CalibrationPlane | null,
  candidate: IntegerCandidate,
  params: HeightParams = { coordinateUnit: 'm' }
): HeightField {
  const g = phase.grid;
  let factor: number | null = null;
  let diagnostic: string | undefined;
  const lambda = wavelength?.lambda.value ?? null;
  const ti = geometry?.incidenceAngle.value ?? null;
  const to = geometry?.observationAngle.value ?? null;

  if (lambda === null) {
    diagnostic = 'wavelength unparsable: height chain stops after fringe order';
  } else if (ti === null || to === null) {
    diagnostic = 'geometry angle unparsable: sensitivity factor unavailable';
  } else {
    const denom = Math.cos((ti * Math.PI) / 180) + Math.cos((to * Math.PI) / 180);
    if (denom <= 1e-9) {
      diagnostic = 'cos(theta_i)+cos(theta_o) <= 0: degenerate illumination geometry';
    } else {
      factor = lambda / (2 * Math.PI * denom);
    }
  }

  const chains: HeightPixelChain[] = [];
  let used = 0;
  let sumSq = 0;
  for (let p = 0; p < g.width * g.height; p++) {
    const wrapped = phase.phase[p];
    const k = candidate.k[p];
    const unwrapped = wrapped === null || k === null ? null : wrapped + 2 * Math.PI * k;
    const fringe = unwrapped === null ? null : unwrapped / (2 * Math.PI);
    const rel = factor !== null && unwrapped !== null ? factor * unwrapped : null;
    let plane = 0;
    if (calibration) {
      const { x, y } = xy(g, p);
      const a = calibration.a.value ?? 0;
      const b = calibration.b.value ?? 0;
      const c = calibration.c.value ?? 0;
      plane = a * x + b * y + c;
    }
    const h = rel === null ? null : rel + plane;
    if (h !== null) {
      used++;
      sumSq += h * h;
    }
    chains.push({
      pixel: p,
      wrappedRad: wrapped,
      k,
      unwrappedRad: unwrapped,
      fringeOrder: fringe,
      sensitivityFactor: factor,
      relativeHeight: rel,
      planeAdjustment: calibration ? plane : null,
      calibratedHeight: h,
      unit: params.coordinateUnit,
    });
  }

  const rms = used ? Math.sqrt(sumSq / used) : null;
  return {
    grid: g,
    formula: HEIGHT_FORMULA,
    sensitivityFactor: {
      raw: 'lambda/(2*pi*(cos(theta_i)+cos(theta_o)))',
      value: factor,
      unit: 'm/rad',
      diagnostic,
    },
    wavelengthValue: lambda,
    geometryAngles: { incidenceDeg: ti, observationDeg: to },
    chains,
    rmsResidual: { raw: 'rms(height)', value: rms, unit: params.coordinateUnit },
  };
}
