import type {
  CalibrationPlane,
  CutEdit,
  Fragment,
  IncidenceGeometry,
  InputKind,
  ScenarioKind,
  WavelengthSource
} from './types.ts';
import { stableHash } from './determinism.ts';

export const CASE_PACK_ID = 'interferometric-ledger-offline';
export const CASE_PACK_VERSION = '2026.09.23';
export const FIXED_SEED = 1729;

export type TileLayerName = 'wrapped_phase' | 'amplitude' | 'signal_noise' | 'invalid_mask';
export type CaseProjectSpec = {
  id: string;
  name: string;
  scenario: ScenarioKind;
  width: number;
  height: number;
  narrative: string;
  phase: (x: number, y: number) => number;
  amplitude: (x: number, y: number) => number;
  signalNoise: (x: number, y: number) => number;
  invalid: (x: number, y: number) => boolean;
  invalidReason?: (x: number, y: number) => 'mask_imported' | 'outside_calibration';
};
export type CasePack = {
  id: string;
  version: string;
  fixedSeed: number;
  generatedAt: number;
  domain: 'interferometric_fringe_ledger';
  unitsPolicy: string;
  projects: CaseProjectSpec[];
  fragments: Fragment[];
  layouts: Record<string, Array<{ id: string; x: number; y: number }>>;
  scalarSources: Record<string, Fragment>;
};

function clampRad(value: number): number {
  let v = value;
  while (v > Math.PI) v -= Math.PI * 2;
  while (v < -Math.PI) v += Math.PI * 2;
  return Number(v.toFixed(6));
}

const smoothPhase = (x: number, y: number) => clampRad(0.18 * x + 0.13 * y);
const goodAmplitude = (x: number, y: number) => Number((0.92 + 0.01 * x - 0.008 * y).toFixed(3));
const goodSnr = (x: number, y: number) => Number((18 + x - 0.4 * y).toFixed(2));
const valid = () => false;
const noReason = () => 'mask_imported' as const;

function boundaryPhase(x: number, y: number): number {
  if (y === 0 && x === 3) return Math.PI - 0.08;
  if (y === 1 && x === 0) return -Math.PI + 0.05;
  return smoothPhase(x, y);
}

function holeAmplitude(x: number, y: number): number {
  return x === 1 && y === 1 ? 0.035 : goodAmplitude(x, y);
}

function holeSnr(x: number, y: number): number {
  return x === 1 && y === 1 ? 2.5 : goodSnr(x, y);
}

function splitMask(x: number, y: number): boolean {
  return (x === 2 && (y === 1 || y === 3)) || (y === 2 && x >= 1 && x <= 3);
}

function vortexPhase(x: number, y: number): number {
  const table = [
    [3.0, -2.9],
    [-0.2, 2.4]
  ];
  if (x < 2 && y < 2) return table[y][x];
  return smoothPhase(x, y);
}

function ambiguityPhase(x: number, y: number): number {
  if (x === 1 && y === 1) return -0.2;
  return vortexPhase(x, y);
}

function combinedPhase(x: number, y: number): number {
  if (x === 5 && y === 1) return Math.PI - 0.05;
  if (x >= 0 && x <= 1 && y >= 0 && y <= 1) return vortexPhase(x, y);
  if (x === 3 && y === 3) return -0.4;
  return clampRad(0.12 * x + 0.1 * y + (x > 5 ? Math.PI : 0));
}
function combinedAmplitude(x: number, y: number): number {
  if (x === 3 && y === 3) return 0.03;
  return Number((0.9 + 0.004 * x - 0.005 * y).toFixed(3));
}
function combinedSnr(x: number, y: number): number {
  if (x === 3 && y === 3) return 2.1;
  return Number((17 + 0.2 * x - 0.15 * y).toFixed(2));
}
function combinedMask(x: number, y: number): boolean {
  return (x === 3 && (y === 2 || y === 4)) || (y === 3 && x >= 2 && x <= 4);
}

export const caseSpecs: CaseProjectSpec[] = [
  {
    id: 'case-min-wrap-boundary',
    name: '最小反例：相位跨越边界',
    scenario: 'phase_wrap_boundary',
    width: 4,
    height: 4,
    narrative: '相邻包裹相位从近 +π 跳到近 -π，整周候选必须显式补 2π。',
    phase: boundaryPhase,
    amplitude: goodAmplitude,
    signalNoise: goodSnr,
    invalid: valid
  },
  {
    id: 'case-min-low-amplitude-hole',
    name: '最小反例：低振幅孔洞',
    scenario: 'low_amplitude_hole',
    width: 4,
    height: 4,
    narrative: '孔洞中心保留 unknown；系统不得为绘图猜测相位。',
    phase: smoothPhase,
    amplitude: holeAmplitude,
    signalNoise: holeSnr,
    invalid: valid
  },
  {
    id: 'case-min-multiconnected',
    name: '最小反例：多连通区',
    scenario: 'multiconnected_region',
    width: 4,
    height: 4,
    narrative: '遮罩墙形成带孔的有效域；不同区域路径与支路切口独立留档。',
    phase: smoothPhase,
    amplitude: goodAmplitude,
    signalNoise: goodSnr,
    invalid: splitMask,
    invalidReason: () => 'mask_imported'
  },
  {
    id: 'case-min-cycle-misclosure',
    name: '最小反例：循环不闭合',
    scenario: 'cycle_misclosure',
    width: 4,
    height: 4,
    narrative: '2×2 单元存在 +2π 残差，支路切口阻止跨残差积分。',
    phase: vortexPhase,
    amplitude: goodAmplitude,
    signalNoise: goodSnr,
    invalid: valid
  },
  {
    id: 'case-min-wavelength-version',
    name: '最小反例：波长版本变更',
    scenario: 'wavelength_version_change',
    width: 4,
    height: 4,
    narrative: '波长 632.8 nm 到 650.0 nm 的修订只产生新版本，不覆盖旧高度。',
    phase: smoothPhase,
    amplitude: goodAmplitude,
    signalNoise: goodSnr,
    invalid: valid
  },
  {
    id: 'case-min-integer-ambiguity',
    name: '最小反例：整周多解',
    scenario: 'integer_ambiguity',
    width: 4,
    height: 4,
    narrative: '两个整周值均局部合法；采纳与未采纳候选共同保留。',
    phase: ambiguityPhase,
    amplitude: goodAmplitude,
    signalNoise: goodSnr,
    invalid: valid
  },
  {
    id: 'case-min-lock-conflict',
    name: '最小反例：局部锁定冲突',
    scenario: 'local_lock_conflict',
    width: 4,
    height: 4,
    narrative: '相邻局部解读要求互斥整周偏移，第二次锁定进入 conflicted。',
    phase: ambiguityPhase,
    amplitude: goodAmplitude,
    signalNoise: goodSnr,
    invalid: valid
  },
  {
    id: 'case-combined-narrative',
    name: '组合输入：光学实验室二维相位展开复核',
    scenario: 'combined_narrative',
    width: 8,
    height: 8,
    narrative: '包裹相位、振幅、遮罩和标定帧导入后，沿边界、孔洞、多连通、残差、波长与锁定冲突完成完整复核。',
    phase: combinedPhase,
    amplitude: combinedAmplitude,
    signalNoise: combinedSnr,
    invalid: combinedMask,
    invalidReason: () => 'mask_imported'
  }
];

function makeScalarFragment(kind: InputKind, label: string, data: unknown): Fragment {
  const originalRepresentation = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    id: `frag_${kind}_${stableHash({ kind, label, data }).slice(0, 16)}`,
    kind,
    role: label,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    originalRepresentation,
    data,
    sha256: stableHash({ kind, label, data })
  };
}

export function defaultWavelength(): WavelengthSource {
  return {
    value: 632.8,
    unit: 'nanometer',
    originalRepresentation: '632.8 nm HeNe laser, n=1.000293 air',
    coordinateBasis: 'sensor_millimeter',
    mediumRefractiveIndex: 1.000293,
    mediumRefractiveIndexRepresentation: 'n_air=1.000293 @20C'
  };
}
export function revisedWavelength(): WavelengthSource {
  return {
    value: 650.0,
    unit: 'nanometer',
    originalRepresentation: '650.0 nm diode source, n=1.000293 air',
    coordinateBasis: 'sensor_millimeter',
    mediumRefractiveIndex: 1.000293,
    mediumRefractiveIndexRepresentation: 'n_air=1.000293 @20C'
  };
}
export function defaultGeometry(): IncidenceGeometry {
  return {
    incidenceAngle: { value: 32.0, unit: 'degree', originalRepresentation: 'theta_i=32.0 deg' },
    observationAngle: { value: 0.0, unit: 'degree', originalRepresentation: 'theta_o=0.0 deg normal viewing' },
    sensitivityVector: { x: 0.5299, y: 0, z: 0.8480, basis: 'sensor_millimeter' }
  };
}
export function defaultCalibration(): CalibrationPlane {
  return {
    equation: { a: 0, b: 0, c: 1, d: 0 },
    equationUnit: { a: 'dimensionless', b: 'dimensionless', c: 'dimensionless', d: 'millimeter' },
    origin: { x: 0, y: 0, z: 0 },
    coordinateBasis: 'sensor_millimeter',
    originalRepresentation: 'z=0 reference calibration plane; pixel pitch=0.010 mm'
  };
}
export function defaultCutHistory(): CutEdit[] {
  return [
    { edgeId: 'e_0_0_1_0', action: 'place_branch_cut', reason: 'imported positive residue branch cut baseline', editor: 'goldstein_residue_rule' }
  ];
}

function makeTile(spec: CaseProjectSpec, tx: number, ty: number): Fragment {
  const rows = [];
  for (let y = ty; y < Math.min(spec.height, ty + 2); y += 1) {
    const row = [];
    for (let x = tx; x < Math.min(spec.width, tx + 2); x += 1) {
      row.push({
        x,
        y,
        wrapped_phase: spec.phase(x, y),
        amplitude: spec.amplitude(x, y),
        signal_noise: spec.signalNoise(x, y),
        invalid_mask: spec.invalid(x, y),
        invalid_reason: spec.invalid(x, y) ? (spec.invalidReason?.(x, y) ?? 'mask_imported') : 'valid'
      });
    }
    rows.push(row);
  }
  const data = rows;
  const sha = stableHash(data);
  return {
    id: `tile_${sha.slice(0, 16)}`,
    kind: 'tile',
    x: tx,
    y: ty,
    width: Math.min(2, spec.width - tx),
    height: Math.min(2, spec.height - ty),
    coordinateBasis: 'pixel_index_zero_based',
    originalRepresentation: JSON.stringify(rows),
    data,
    sha256: sha
  };
}

export function buildCasePack(now = 1780000000000): CasePack {
  const fragments = new Map<string, Fragment>();
  const layouts: CasePack['layouts'] = {};
  for (const spec of caseSpecs) {
    const tiles = [];
    for (let y = 0; y < spec.height; y += 2) {
      for (let x = 0; x < spec.width; x += 2) {
        const tile = makeTile(spec, x, y);
        fragments.set(tile.id, tile);
        tiles.push({ id: tile.id, x, y });
      }
    }
    layouts[spec.id] = tiles;
  }
  const scalarSources = {
    wavelength_v1: makeScalarFragment('wavelength', 'initial wavelength', defaultWavelength()),
    wavelength_v2: makeScalarFragment('wavelength', 'parameter revision wavelength', revisedWavelength()),
    incidence_geometry: makeScalarFragment('incidence_geometry', 'fixed illumination geometry', defaultGeometry()),
    calibration_plane: makeScalarFragment('calibration_plane', 'reference calibration frame', defaultCalibration()),
    cut_history_v1: makeScalarFragment('cut_edit_history', 'immutable initial cut edits', defaultCutHistory())
  };
  for (const fragment of Object.values(scalarSources)) fragments.set(fragment.id, fragment);
  return {
    id: CASE_PACK_ID,
    version: CASE_PACK_VERSION,
    fixedSeed: FIXED_SEED,
    generatedAt: now,
    domain: 'interferometric_fringe_ledger',
    unitsPolicy: 'imported values retain units/original representation; normalization exists only on derived layers',
    projects: caseSpecs,
    fragments: [...fragments.values()],
    layouts,
    scalarSources
  };
}
