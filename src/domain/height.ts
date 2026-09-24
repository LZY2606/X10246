import { fnv1a32 } from "./hash";
import { TWO_PI } from "./units";
import { HEIGHT_ALGORITHM_VERSION, fingerprintParams } from "./engine";
import type { Grid2D, HeightChainResult, HeightStage, UnwrapTreeResult, VersionEntity } from "./types";

export interface HeightParams {
  phaseBias: number;
  opticalFactor: number;
  planeOffset: number;
}

export const DEFAULT_HEIGHT_PARAMS: HeightParams = {
  phaseBias: 0,
  opticalFactor: 1,
  planeOffset: 0,
};

/**
 * 高度转换链，逐阶段保留，便于页面“高度转换链”面板复核：
 *   展开相位(rad) -> 相位(turn) -> 光程差 OPD=λ·φ/2π -> 几何因子 -> 表面高度 -> 标定面校正
 */
export function buildHeightChain(
  unwrap: UnwrapTreeResult,
  wavelength: VersionEntity,
  geometry: VersionEntity,
  calibration: VersionEntity,
  params: HeightParams,
  createdAtEventId: string
): HeightChainResult {
  const wlP = wavelength.payload as { value: number; unit: string };
  const geoP = geometry.payload as { incidenceAngleRad: number; sensitivity?: number };
  const calP = calibration.payload as { zOffset?: number; planeA?: number; planeB?: number };

  const wavelengthMeters = toMeters(wlP.value, wlP.unit);
  const cosFactor = Math.cos(geoP.incidenceAngleRad ?? 0);
  const sensitivity = geoP.sensitivity ?? 1;
  const { rows, cols } = unwrap.grid;

  const phaseTurns = new Array<number>(rows * cols).fill(NaN);
  const opd = new Array<number>(rows * cols).fill(NaN);
  const heightGrid = new Array<number>(rows * cols).fill(NaN);

  for (let i = 0; i < rows * cols; i++) {
    const phi = unwrap.grid.data[i];
    if (Number.isNaN(phi)) continue;
    const unbiased = phi - params.phaseBias;
    phaseTurns[i] = unbiased / TWO_PI;
    opd[i] = wavelengthMeters * phaseTurns[i] * params.opticalFactor;
    // 几何投影：法向位移 = OPD / (2·cosθ·sensitivity)
    let h = opd[i] / (2 * cosFactor * sensitivity);
    // 标定面平面校正：z = h - (z0 + a·c + b·r)
    const r = Math.floor(i / cols);
    const c = i % cols;
    h -= (calP.zOffset ?? 0) + (calP.planeA ?? 0) * c + (calP.planeB ?? 0) * r;
    h -= params.planeOffset;
    heightGrid[i] = h;
  }

  const grid: Grid2D = { rows, cols, data: heightGrid, unit: "m", coordinateFrame: "lab_xyz" };
  const stages: HeightStage[] = [
    { stageId: "st_phase_turns", name: "展开相位→周数", formula: "n=φ/2π", inputs: [unwrap.resultId], unit: "turn" },
    { stageId: "st_opd", name: "周数→光程差", formula: "OPD=λ·n", inputs: [wavelength.versionId], unit: "m" },
    { stageId: "st_geometry", name: "入射几何投影", formula: "h=OPD/(2·cosθ·s)", inputs: [geometry.versionId], unit: "m" },
    { stageId: "st_calib", name: "标定面校正", formula: "z=h-(z0+a·c+b·r)", inputs: [calibration.versionId], unit: "m" },
  ];

  const resultId =
    `height_${fnv1a32(
      [unwrap.resultId, wavelength.versionId, geometry.versionId, calibration.versionId,
        HEIGHT_ALGORITHM_VERSION, JSON.stringify(params)].join("|")
    ).slice(0, 12)}`;

  return {
    resultId,
    unwrapResultId: unwrap.resultId,
    wavelengthVersionId: wavelength.versionId,
    geometryVersionId: geometry.versionId,
    calibrationVersionId: calibration.versionId,
    algorithmVersion: HEIGHT_ALGORITHM_VERSION,
    paramsFingerprint: fingerprintParams(params),
    chain: stages,
    heightGrid: grid,
    status: "current",
    createdAtEventId,
  };
}

function toMeters(value: number, unit: string): number {
  const f: Record<string, number> = { nm: 1e-9, um: 1e-6, mm: 1e-3, m: 1 };
  if (f[unit] === undefined) return NaN;
  return value * f[unit];
}
