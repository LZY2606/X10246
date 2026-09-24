import { Grid, makeGrid, wrapPhase, TWO_PI } from './grid';
import { Quantity } from './units';
import { CalibrationPlane } from './height';
import { CutEdge } from './unwrap';
import { seededRng } from './canon';

/**
 * 七个验收场景。每个场景提供一个最小输入与一个组合输入；
 * 两者共享的原始片段（波长、几何、标定、基础相位块）内容相同，
 * 经内容寻址存储只保存一份不可变内容。
 */
export interface ScenarioInputSet {
  wrapped_phase: Grid;
  quality_score: Grid;
  invalid_mask: Grid;
  wavelength: Quantity;
  incident_geometry: { angle: Quantity; frame: string };
  calibration_plane: CalibrationPlane;
  cut_edit_history: { edits: CutEdge[] };
}

export interface ScenarioDef {
  key: string;
  title: string;
  expectDiagnostics: string[];
  minimal: () => ScenarioInputSet;
  combo: () => ScenarioInputSet;
}

const W = 12, H = 12;

function baseTrueSurface(): Grid {
  return makeGrid(W, H, (x, y) => 0.35 * x + 0.22 * y + 2.4 * Math.exp(-((x - 6) ** 2 + (y - 6) ** 2) / 8));
}

function wrapOf(truePhase: Grid): Grid {
  return makeGrid(W, H, (x, y) => wrapPhase(truePhase.data[y * W + x]!));
}

function fullQuality(v = 0.92): Grid {
  return makeGrid(W, H, () => v);
}

function fullMask(): Grid {
  return makeGrid(W, H, () => 1);
}

const HE_NE: Quantity = { value: 632.8, unit: 'nm', frame: 'optical-bench' };
const NORMAL_INCIDENCE = { angle: { value: 0, unit: 'deg' } as Quantity, frame: 'optical-bench' };
const FLAT_CAL: CalibrationPlane = { a: 0.01, b: -0.02, c: 0.3 };
const NO_EDITS = { edits: [] as CutEdge[] };

function baseSet(truePhase: Grid): ScenarioInputSet {
  return {
    wrapped_phase: wrapOf(truePhase),
    quality_score: fullQuality(),
    invalid_mask: fullMask(),
    wavelength: HE_NE,
    incident_geometry: NORMAL_INCIDENCE,
    calibration_plane: FLAT_CAL,
    cut_edit_history: NO_EDITS
  };
}

/** 相位跨越边界：x>=6 处真面相位跳变 1.5 个整周，包裹场出现边界。 */
function boundaryTrue(): Grid {
  const t = baseTrueSurface();
  return makeGrid(W, H, (x, y) => t.data[y * W + x]! + (x >= 6 ? 1.5 * TWO_PI : 0));
}

/** 低振幅孔洞：中心圆形区域振幅（质量）接近零。 */
function holeQuality(): Grid {
  return makeGrid(W, H, (x, y) => ((x - 6) ** 2 + (y - 6) ** 2 <= 4 ? 0.05 : 0.92));
}

/** 多连通区：遮罩在 x=6 处断开，形成左右两个孤岛。 */
function splitMask(): Grid {
  return makeGrid(W, H, (x) => (x === 6 ? 0 : 1));
}

/** 循环不闭合：中心放置 +1 螺旋位错，残差点无法配对，环流不为零。 */
function dislocationTrue(): Grid {
  const t = baseTrueSurface();
  return makeGrid(W, H, (x, y) => {
    const dx = x - 5.5, dy = y - 5.5;
    return t.data[y * W + x]! + Math.atan2(dy, dx);
  });
}

/** 整周多解：陡坡 + 固定 seed 噪声，使两种树序在部分像素给出不同整周数。 */
function noisySteepSet(seed: number): ScenarioInputSet {
  const rng = seededRng(seed);
  const truePhase = makeGrid(W, H, (x, y) => 0.9 * Math.PI * x / 3 + 0.7 * Math.PI * y / 3);
  const wrapped = makeGrid(W, H, (x, y) => wrapPhase(truePhase.data[y * W + x]! + (rng() - 0.5) * 1.8));
  return { ...baseSet(truePhase), wrapped_phase: wrapped };
}

/** 组合场：边界 + 孔洞 + 多连通 + 位错，共享同一批原始片段。 */
function comboSet(): ScenarioInputSet {
  const t = boundaryTrue();
  const dis = dislocationTrue();
  const truePhase = makeGrid(W, H, (x, y) => t.data[y * W + x]! + (dis.data[y * W + x]! - baseTrueSurface().data[y * W + x]!));
  return {
    ...baseSet(truePhase),
    quality_score: holeQuality(),
    invalid_mask: splitMask()
  };
}

export const SCENARIOS: ScenarioDef[] = [
  {
    key: 'boundary_crossing',
    title: '相位跨越边界',
    expectDiagnostics: [],
    minimal: () => baseSet(boundaryTrue()),
    combo: comboSet
  },
  {
    key: 'low_amplitude_hole',
    title: '低振幅孔洞',
    expectDiagnostics: ['low_amplitude_no_guess'],
    minimal: () => ({ ...baseSet(baseTrueSurface()), quality_score: holeQuality() }),
    combo: comboSet
  },
  {
    key: 'multi_connected',
    title: '多连通区',
    expectDiagnostics: ['multi_connected_region'],
    minimal: () => ({ ...baseSet(baseTrueSurface()), invalid_mask: splitMask() }),
    combo: comboSet
  },
  {
    key: 'cycle_inconsistency',
    title: '循环不闭合',
    expectDiagnostics: ['cycle_inconsistency'],
    minimal: () => baseSet(dislocationTrue()),
    combo: comboSet
  },
  {
    key: 'wavelength_version_change',
    title: '波长版本变更',
    expectDiagnostics: [],
    minimal: () => baseSet(baseTrueSurface()),
    combo: comboSet
  },
  {
    key: 'integer_ambiguity',
    title: '整周多解',
    expectDiagnostics: ['integer_ambiguity'],
    minimal: () => noisySteepSet(20260919),
    combo: comboSet
  },
  {
    key: 'lock_conflict',
    title: '局部锁定冲突',
    expectDiagnostics: [],
    minimal: () => noisySteepSet(1217),
    combo: comboSet
  }
];

export function scenarioByKey(key: string): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.key === key);
}
