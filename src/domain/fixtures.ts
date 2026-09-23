/**
 * 离线领域样例：“干涉条纹簿：相位展开、支路切口与光学标定分支”。
 *
 * 共享片段 F（8x8）在所有最小输入与组合输入中只存一份不可变内容；
 * 每个情景额外有自己的局部片段，解释版本、失败诊断、人工决定各自独立。
 */
import type {
  AngleGeometry,
  CalibrationSurface,
  InputBundle,
  RawTile,
  WavelengthSpec,
} from './vocabulary.ts';
import { SeededRng } from '../shared/rng.ts';

export type ScenarioTag =
  | 'shared-fragment'
  | 'boundary-crossing'
  | 'low-amplitude-hole'
  | 'multiconnected'
  | 'cycle-nonclosure'
  | 'wavelength-revision'
  | 'integer-ambiguity'
  | 'local-lock-conflict';

export const SCENARIO_TAGS: ScenarioTag[] = [
  'boundary-crossing',
  'low-amplitude-hole',
  'multiconnected',
  'cycle-nonclosure',
  'wavelength-revision',
  'integer-ambiguity',
  'local-lock-conflict',
];

export function wrapRad(x: number): number {
  const twoPi = 2 * Math.PI;
  return ((x + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
}

function tile(
  tileId: string,
  offsetRow: number,
  offsetCol: number,
  rows: number,
  cols: number,
  fill: (r: number, c: number) => { p: number; a: number; invalid?: boolean; reason?: string | null },
): RawTile {
  const phase = new Float64Array(rows * cols);
  const amplitude = new Float64Array(rows * cols);
  const invalid = new Uint8Array(rows * cols);
  const invalidReason: (string | null)[] = new Array(rows * cols).fill(null);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const v = fill(r, c);
      phase[i] = v.p;
      amplitude[i] = v.a;
      invalid[i] = v.invalid ? 1 : 0;
      invalidReason[i] = v.reason ?? null;
    }
  }
  return { tileId, offsetRow, offsetCol, rows, cols, phase, phaseUnit: 'rad', amplitude, amplitudeUnit: 'adu', invalid, invalidReason };
}

/** 共享片段 F：平缓斜变 + 一次 ±π 边界跨越，振幅良好。 */
export function sharedFragment(): RawTile {
  return tile('tile-shared-F', 0, 0, 8, 8, (r, c) => ({
    p: wrapRad(0.12 * r + 0.95 * c),
    a: 100 + 6 * Math.sin(0.7 * r + 0.31 * c),
  }));
}

/** P1 相位跨越边界：更强斜变，连续跨越多次 ±π。 */
function patchBoundary(): RawTile {
  return tile('tile-boundary-P1', 0, 8, 8, 8, (r, c) => ({
    p: wrapRad(2.62 * c - 0.42 * r),
    a: 110 + 5 * Math.cos(0.5 * r),
  }));
}

/** P2 低振幅孔洞：遮罩仍有效，但中心孔洞振幅低于噪声地板——不得猜相位。 */
function patchLowAmplitudeHole(): RawTile {
  const rng = new SeededRng(20260924);
  return tile('tile-lowamp-hole-P2', 0, 16, 8, 6, (r, c) => {
    const inHole = r >= 2 && r <= 5 && c >= 2 && c <= 3;
    return {
      p: wrapRad(0.2 * c + (inHole ? (rng.next() - 0.5) * 6 : 0.1 * r)),
      a: inHole ? 2 + rng.next() * 4 : 120 + 4 * rng.next(),
    };
  });
}

/** P3 多连通区：有效像素被遮罩切成 3 个连通分量。 */
function patchMulticonnected(): RawTile {
  return tile('tile-multiconn-P3', 10, 17, 6, 6, (r, c) => {
    const barrier = c === 3 || (r === 3 && c <= 2);
    return {
      p: wrapRad(0.15 * c + 0.08 * r),
      a: 105,
      invalid: barrier,
      reason: barrier ? 'stage-occluder' : null,
    };
  });
}

/** P4 循环不闭合：整块只有中心像元方块带 -1 残差，四周场光滑延续。 */
function patchNonclosure(): RawTile {
  return tile('tile-nonclosure-P4', 8, 0, 5, 5, (r, c) => {
    let p = 0;
    if (r === 2 && c === 2) p = 0.2;
    if (r === 2 && c === 3) p = 3.0;
    if (r === 3 && c === 3) p = 0.4;
    if (r === 3 && c === 2) p = -2.6;
    if (r === 4) p = c === 2 ? -2.6 : c === 3 ? 0.4 : 0;
    return { p, a: 100 };
  });
}

/** P6 整周多解：切口两侧 2π 邻域存在两个都合法的整周候选。 */
function patchIntegerAmbiguity(): RawTile {
  return tile('tile-ambiguity-P6', 8, 6, 5, 5, (_r, c) => ({
    p: c >= 3 ? wrapRad(-3.08) : 0,
    a: 30,
  }));
}

/** P7 局部锁定冲突：两个分量被遮挡列分开，跨缝偏移不可观测。 */
function patchLockConflict(): RawTile {
  return tile('tile-lockconflict-P7', 8, 12, 5, 5, (_r, c) => {
    const gap = c === 2;
    return {
      p: c <= 1 ? wrapRad(0.1 * c) : wrapRad(0.08 * c),
      a: 95,
      invalid: gap,
      reason: gap ? 'occluder-column' : null,
    };
  });
}

export interface ScenarioPatch {
  tag: ScenarioTag;
  tile: RawTile;
  /** 组合输入网格内的偏移（与最小输入同一瓦片内容，天然共享一份）。 */
  compositeOffset: { row: number; col: number };
}

export function scenarioPatches(): ScenarioPatch[] {
  return [
    { tag: 'boundary-crossing', tile: patchBoundary(), compositeOffset: { row: 0, col: 8 } },
    { tag: 'low-amplitude-hole', tile: patchLowAmplitudeHole(), compositeOffset: { row: 0, col: 16 } },
    { tag: 'multiconnected', tile: patchMulticonnected(), compositeOffset: { row: 10, col: 17 } },
    { tag: 'cycle-nonclosure', tile: patchNonclosure(), compositeOffset: { row: 8, col: 0 } },
    { tag: 'integer-ambiguity', tile: patchIntegerAmbiguity(), compositeOffset: { row: 8, col:6 } },
    { tag: 'local-lock-conflict', tile: patchLockConflict(), compositeOffset: { row: 8, col: 12 } },
  ];
}

export const COMPOSITE_ROWS = 24;
export const COMPOSITE_COLS = 24;
export const FIXED_SEED = 20260924;

export function wavelengthV1(): WavelengthSpec {
  return { value: 632.8, unit: 'nm', medium: 'air', rawRepresentation: '632.8 nm (HeNe 标称, 出厂标定 v1)' };
}

export function wavelengthV2(): WavelengthSpec {
  return { value: 633.0, unit: 'nm', medium: 'air', rawRepresentation: '633.0 nm (波长计实测, 修订 v2)' };
}

export function geometryV1(): AngleGeometry {
  return { incidenceDeg: 15, azimuthDeg: 90, rawRepresentation: '入射角 15°，入射面方位 90°（沿行方向）' };
}

export function calibrationPlane(): CalibrationSurface {
  const rows = COMPOSITE_ROWS;
  const cols = COMPOSITE_COLS;
  const values = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      values[r * cols + c] = 0.05 * r + 0.02 * c;
    }
  }
  return {
    height: { unit: 'um', values },
    heightUnit: 'um',
    shape: 'tilted-plane',
    rawRepresentation: '参考平面 z=0.05r+0.02c µm/px（光学校准台 2026-01 记录）',
  };
}

function basis(rows: number, cols: number) {
  return { origin: 'top-left' as const, rows, cols, spacing: { dy: 5.2, dx: 5.2 }, spacingUnit: 'um' as const };
}

function cutHistorySeed() {
  return [
    {
      editId: 'cut-init-0001',
      at: '2026-01-01T00:00:00.000Z',
      action: 'add-cut' as const,
      edge: { a: -1, b: -1 },
      parentEditId: null,
      note: '初始空切口表（随包不可变）',
    },
  ];
}

/** 组合输入：F + 七个情景片段（P5 波长版本不需要独立瓦片），单张 24x24 网格。 */
export function compositeBundle(): InputBundle {
  const tiles: RawTile[] = [sharedFragment()];
  for (const p of scenarioPatches()) {
    const t = p.tile;
    tiles.push({ ...t, offsetRow: p.compositeOffset.row, offsetCol: p.compositeOffset.col });
  }
  return {
    bundleId: 'bundle-composite-ledger',
    scenarioTag: 'composite',
    basis: basis(COMPOSITE_ROWS, COMPOSITE_COLS),
    tiles,
    wavelength: wavelengthV1(),
    geometry: geometryV1(),
    calibration: calibrationPlane(),
    cutHistory: cutHistorySeed(),
    seed: FIXED_SEED,
  };
}

/** 某情景的最小输入：共享片段 F + 单个情景片段，网格刚好包围两者。 */
export function minimalBundle(tag: ScenarioTag): InputBundle {
  const f = sharedFragment();
  const patch = scenarioPatches().find((p) => p.tag === tag);
  const tiles: RawTile[] = [f];
  let rows = f.rows;
  let cols = f.cols;
  if (patch) {
    const t = patch.tile;
    tiles.push({ ...t, offsetRow: t.offsetRow, offsetCol: t.offsetCol });
    rows = Math.max(rows, t.offsetRow + t.rows);
    cols = Math.max(cols, t.offsetCol + t.cols);
  }
  return {
    bundleId: `bundle-min-${tag}`,
    scenarioTag: tag,
    basis: basis(rows, cols),
    tiles,
    wavelength: wavelengthV1(),
    geometry: geometryV1(),
    calibration: calibrationPlane(),
    cutHistory: cutHistorySeed(),
    seed: FIXED_SEED,
  };
}

/** 含一个不可转换值的坏样例：用于导入层明确的格式错误测试。 */
export function malformedBundle(): InputBundle {
  const base = minimalBundle('boundary-crossing');
  const tiles = base.tiles.map((t) => {
    if (t.tileId !== 'tile-shared-F') return t;
    const phase = t.phase.slice();
    const amplitude = t.amplitude.slice();
    phase[0] = Number.NaN;
    amplitude[1] = -7;
    return { ...t, phase, amplitude };
  });
  return { ...base, bundleId: 'bundle-malformed', scenarioTag: 'boundary-crossing', tiles };
}
