import { TWO_PI, angleToRad, nmToUm } from '../domain/units';
import type {
  Grid2D, AlgorithmProvenance, HeightMap, UnwrapCandidate,
  RawPhaseFrame, WavelengthSpec, IncidenceGeometry, CalibrationSurface
} from '../domain/types';

/**
 * 高度转换链（逐步保留，不只给最终数字）：
 *   wrapped -> unwrapped -> 减去标定面相位 -> 相位差(rad)
 *           -> 灵敏度因子(lambda / 2pi / tan(theta)) -> 高度(um)
 * 无法转换的值留在原位置并附诊断，绝不为画图而丢。
 */
export function convertHeight(
  grid: Grid2D,
  candidate: UnwrapCandidate,
  phaseFrame: RawPhaseFrame,
  wavelength: WavelengthSpec,
  geometry: IncidenceGeometry,
  calibration: CalibrationSurface | null,
  provenance: AlgorithmProvenance
): HeightMap {
  const n = grid.width * grid.height;
  const wrapped = phaseFrame.cells.map((c) => c.value);
  const unwrapped = candidate.unwrappedRad.map((v) => v);

  const angleConv = angleToRad(
    geometry.incidenceAngle.value ?? NaN,
    geometry.incidenceAngle.units === 'nm' ? 'rad' : geometry.incidenceAngle.units
  );
  const diagnostics: Record<number, string> = {};

  let reference: (number | null)[];
  if (calibration) {
    reference = calibration.referencePhase.map((c) => c.value);
  } else {
    reference = new Array(n).fill(0);
  }

  const phaseDelta: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (unwrapped[i] === null) {
      diagnostics[i] = 'not-unwrapped (masked/low-amplitude) — kept empty, never guessed';
      continue;
    }
    const ref = reference[i] ?? 0;
    phaseDelta[i] = (unwrapped[i] as number) - ref;
  }

  const sensitivityUmPerRad: (number | null)[] = new Array(n).fill(null);
  const heightUm: (number | null)[] = new Array(n).fill(null);

  const lambdaNm = wavelength.lambda.value;
  const theta = angleConv.value;
  if (lambdaNm === null) {
    for (let i = 0; i < n; i++) diagnostics[i] = (diagnostics[i] ? diagnostics[i] + '; ' : '') + 'wavelength-unconvertible-kept-in-place';
  } else if (theta === null || !Number.isFinite(theta)) {
    for (let i = 0; i < n; i++) diagnostics[i] = (diagnostics[i] ? diagnostics[i] + '; ' : '') + 'incidence-angle-unconvertible-kept-in-place';
  } else {
    const tanTheta = Math.tan(theta);
    if (Math.abs(tanTheta) < 1e-9) {
      for (let i = 0; i < n; i++) diagnostics[i] = (diagnostics[i] ? diagnostics[i] + '; ' : '') + 'degenerate-geometry:tan(theta)=0';
    } else {
      // 条纹投影：h = Δφ·λ / (2π·tan θ)
      const kUm = nmToUm(lambdaNm) / (TWO_PI * tanTheta);
      for (let i = 0; i < n; i++) sensitivityUmPerRad[i] = kUm;
      for (let i = 0; i < n; i++) {
        if (phaseDelta[i] !== null) heightUm[i] = (phaseDelta[i] as number) * kUm;
      }
    }
  }

  return {
    kind: 'HeightMap', id: '', provenance, candidateId: candidate.id,
    chain: [
      { step: 'wrapped-phase', formula: 'phi(x,y) in (-pi, pi]', units: 'rad', perPixel: wrapped },
      { step: 'unwrapped-phase', formula: 'phi + 2*pi*n(x,y)', units: 'rad', perPixel: unwrapped },
      { step: 'calibration-reference', formula: 'phi_ref(x,y) from calibration surface', units: 'rad', perPixel: reference },
      { step: 'phase-delta', formula: 'phi_unwrapped - phi_ref', units: 'rad', perPixel: phaseDelta },
      { step: 'sensitivity', formula: 'lambda / (2*pi*tan(theta))', units: 'um/rad', perPixel: sensitivityUmPerRad },
      { step: 'height', formula: 'h = delta_phi * lambda / (2*pi*tan(theta))', units: 'um', perPixel: heightUm }
    ],
    heightUm,
    diagnostics
  };
}
