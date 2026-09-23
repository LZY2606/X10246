/**
 * 干涉条纹簿 —— 领域数据契约
 * 直接采用光学干涉 / 相位展开 / 标定领域自身的词汇，
 * 不使用通用 name/value 压扁结构。
 */

export type UnitName =
  | 'rad'
  | 'degree'
  | 'nm'
  | 'um'
  | 'mm'
  | 'm'
  | 'pixel'
  | 'dB'
  | 'unitless'
  | 'arbitrary_amplitude';

export interface UnitSpec {
  /** 该量使用的单位，如 rad / nm / dB */
  unit: UnitName;
  /** 坐标基准，如 pixel / lab_mm，未给则 null */
  coordinateBasis?: string | null;
  /** 单位附加说明，例如 dB reference=1.0 */
  note?: string | null;
}

/** 二维网格的坐标基准 */
export interface GridBasis {
  rows: number;
  cols: number;
  /** 行列坐标基准，默认 pixel（左上角原点，r 向下，c 向右） */
  coordinateBasis: string;
  origin: { r: number; c: number };
  pixelPitch?: { dr: number; dc: number; unit: UnitName } | null;
}

/** 原相位像素：包裹相位 φ∈(-π, π]，单位 rad（导入时保留原始表示） */
export interface WrappedPhaseFrame {
  kind: 'wrapped_phase';
  basis: GridBasis;
  /** 逐像素包裹相位，长度 rows*cols；保留导入时的原始数值表示 */
  pixels: number[];
  /** 导入时声明的取值约定，例如 '(-pi, pi]' */
  rangeConvention: string;
  phaseUnit: UnitSpec;
}

/** 振幅帧（低振幅孔洞判定的直接来源） */
export interface AmplitudeFrame {
  kind: 'amplitude';
  basis: GridBasis;
  pixels: number[];
  amplitudeUnit: UnitSpec;
}

/** 信噪评分（质量图来源） */
export interface SnrScoreMap {
  kind: 'snr_score';
  basis: GridBasis;
  pixels: number[];
  snrUnit: UnitSpec;
}

/** 无效遮罩：true=无效像素，禁止猜相位 */
export interface InvalidMask {
  kind: 'invalid_mask';
  basis: GridBasis;
  flags: boolean[];
  maskUnit: UnitSpec;
}

/** 波长（可修订，以版本表达；高度链直接依赖） */
export interface WavelengthSpec {
  kind: 'wavelength';
  value: number;
  wavelengthUnit: UnitSpec;
  /** 介质，例如 vacuum / air，决定 λ 解释 */
  medium: string;
}

/** 入射几何：照明方向 + 观察方向 + 表面法向 */
export interface IlluminationGeometry {
  kind: 'illumination_geometry';
  /** 从物点指向光源的单位向量（坐标基准内） */
  sourceVector: [number, number, number];
  /** 从物点指向相机的单位向量 */
  observationVector: [number, number, number];
  /** 参考表面法向 */
  surfaceNormal: [number, number, number];
  angleUnit: UnitSpec;
  coordinateBasis: string;
}

/** 标定面：z = a*x + b*y + c，坐标基准与系数单位显式给出 */
export interface CalibrationPlane {
  kind: 'calibration_plane';
  a: number;
  b: number;
  c: number;
  coefficientUnits: {
    slope: UnitName; // a,b 的单位（z单位 / xy单位）
    offset: UnitName; // c 的单位
    xy: UnitName;
    z: UnitName;
  };
  coordinateBasis: string;
}

/** 切口编辑（不可覆盖历史中的单条编辑） */
export interface CutEdit {
  editId: string;
  atTime: string;
  actor: 'human' | 'algorithm';
  /** add / remove 支路切口 */
  action: 'add_cut' | 'remove_cut';
  /** 切口边：两端像素坐标 */
  edge: [{ r: number; c: number }, { r: number; c: number }];
  reason: string;
}

export interface CutEditHistory {
  kind: 'cut_edit_history';
  basis: GridBasis;
  /** 仅追加，不允许覆盖；撤销以反向编辑事件表达 */
  edits: CutEdit[];
}

export type InputPayload =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | SnrScoreMap
  | InvalidMask
  | WavelengthSpec
  | IlluminationGeometry
  | CalibrationPlane
  | CutEditHistory;

export type InputKind = InputPayload['kind'];

export const INPUT_KINDS: InputKind[] = [
  'wrapped_phase',
  'amplitude',
  'snr_score',
  'invalid_mask',
  'wavelength',
  'illumination_geometry',
  'calibration_plane',
  'cut_edit_history',
];

export const INPUT_KIND_LABEL: Record<InputKind, string> = {
  wrapped_phase: '原相位像素（包裹相位）',
  amplitude: '振幅',
  snr_score: '信噪评分',
  invalid_mask: '无效遮罩',
  wavelength: '波长',
  illumination_geometry: '入射几何',
  calibration_plane: '标定面',
  cut_edit_history: '切口编辑历史',
};

/** 算法/规则版本 */
export const ALGORITHM_VERSION = 'unwrap-qualitymst-v1';
export const CUT_ALGORITHM_VERSION = 'branchcut-greedypair-v1';
export const HEIGHT_ALGORITHM_VERSION = 'height-reflection-oop-v1';
export const RESIDUE_ALGORITHM_VERSION = 'residue-plaquette-v1';

/** 反例情形（验收七类） */
export type ScenarioCode =
  | 'phase_boundary_crossing'
  | 'low_amplitude_hole'
  | 'multiply_connected_region'
  | 'cycle_nonclosure'
  | 'wavelength_version_change'
  | 'integer_order_ambiguity'
  | 'local_lock_conflict';

export const SCENARIO_LABEL: Record<ScenarioCode, string> = {
  phase_boundary_crossing: '相位跨越边界',
  low_amplitude_hole: '低振幅孔洞',
  multiply_connected_region: '多连通区',
  cycle_nonclosure: '循环不闭合',
  wavelength_version_change: '波长版本变更',
  integer_order_ambiguity: '整周多解',
  local_lock_conflict: '局部锁定冲突',
};
