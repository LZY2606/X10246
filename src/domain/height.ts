// 高度转换链：连续相位 -> 表面高度，携带波长/入射几何/标定面版本。
import { convertQuantity, UnitConversionError, type GridQuantity } from './core.ts';
import type {
  CalibrationPlane,
  DomainEvent,
  HeightConversion,
  IncidenceGeometry,
  UnwrapCandidate,
  WavelengthSpec,
} from './model.ts';

export const HEIGHT_ALGO_VERSION = 'height/1.0.0';

export interface HeightInput {
  candidate: UnwrapCandidate;
  wavelength: WavelengthSpec;
  wavelengthVersionId: string;
  geometry: IncidenceGeometry;
  geometryVersionId: string;
  calibration: CalibrationPlane;
  calibrationVersionId: string;
}

export interface HeightOutput {
  chain: HeightConversion;
  events: DomainEvent[];
}

/** h = φ·λ / (4π·cosθ) − (a·x + b·y + c)；无法转换的值留在原位置并附诊断。 */
export function convertHeight(input: HeightInput): HeightOutput {
  const events: DomainEvent[] = [];
  const diagnostics: Array<{ row: number; col: number; reason: string }> = [];

  let wavelengthNm: number | null = null;
  try {
    wavelengthNm = convertQuantity(input.wavelength.wavelength, 'nm').value;
  } catch (e) {
    if (e instanceof UnitConversionError) {
      events.push({
        type: 'UnitDiagnostic',
        location: `wavelength:${input.wavelength.laserLabel}`,
        reason: e.message,
      });
    } else throw e;
  }
  let thetaRad = 0;
  try {
    thetaRad = convertQuantity(input.geometry.incidenceAngle, 'rad').value;
  } catch (e) {
    if (e instanceof UnitConversionError) {
      events.push({ type: 'UnitDiagnostic', location: 'incidenceAngle', reason: e.message });
    } else throw e;
  }

  const src = input.candidate.unwrapped;
  const rows = src.length;
  const cols = src[0]?.length ?? 0;
  const height: number[][] = [];
  const scale = wavelengthNm === null ? null : wavelengthNm / (4 * Math.PI * Math.cos(thetaRad)); // nm
  const cal = input.calibration;
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      const phi = src[r][c];
      if (phi === null) {
        // 低振幅/无效像素：不猜高度，留 NaN 占位并附诊断。
        row.push(Number.NaN);
        diagnostics.push({ row: r, col: c, reason: 'no-phase:低振幅或无效像素不得猜相位' });
        continue;
      }
      if (scale === null) {
        row.push(Number.NaN);
        diagnostics.push({ row: r, col: c, reason: 'unit:波长单位无法转换，保留原始表示' });
        continue;
      }
      const planeUm = cal.a.value * c + cal.b.value * r + cal.c.value; // um
      row.push((phi * scale) / 1000 - planeUm); // nm -> um，减标定面
    }
    height.push(row);
  }

  const grid: GridQuantity = { values: height, unit: 'um', frame: 'lab' };
  const chain: HeightConversion = {
    chainId: `chain_${input.candidate.candidateId}`,
    candidateId: input.candidate.candidateId,
    wavelengthVersionId: input.wavelengthVersionId,
    geometryVersionId: input.geometryVersionId,
    calibrationVersionId: input.calibrationVersionId,
    height: grid,
    diagnostics,
  };
  events.push({
    type: 'HeightConverted',
    chainId: chain.chainId,
    candidateId: input.candidate.candidateId,
    wavelengthVersionId: input.wavelengthVersionId,
  });
  return { chain, events };
}
