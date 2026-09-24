// 领域数据契约：直接使用光学干涉 / 相位展开 / 标定词汇，不压成 name/value。

export type Unit = 'rad' | 'deg' | 'cycle' | 'nm' | 'um' | 'mm' | 'm' | 'px' | 'ratio' | 'count';
export type Frame = 'pixel-grid' | 'lab-bench' | 'sample-surface';

export interface Quantity {
  value: number;
  unit: Unit;
  frame?: Frame;
}

export interface GridMeta {
  width: number;
  height: number;
  pixelSize: Quantity; // 像素物理尺寸（如 5.2 um, frame=sample-surface）
  origin: [number, number]; // 实验室坐标原点（px）
  frame: Frame;
}

// ---- 七类不可覆盖输入实体 ----
export const INPUT_KINDS = [
  'wrapped_phase', // 原相位像素（包裹相位, rad）
  'snr_scores', // 信噪评分（0..1）
  'invalid_mask', // 无效遮罩
  'wavelength', // 波长
  'incidence_geometry', // 入射几何
  'calibration_plane', // 标定面
  'cut_edits', // 切口编辑历史
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export interface WrappedPhaseFrame {
  kind: 'wrapped_phase';
  meta: GridMeta;
  data: number[]; // 行主序, rad ∈ (-π, π]
}
export interface SnrScoresFrame {
  kind: 'snr_scores';
  meta: GridMeta;
  data: number[]; // 0..1
}
export interface InvalidMaskFrame {
  kind: 'invalid_mask';
  meta: GridMeta;
  data: (0 | 1)[]; // 1 = 无效
}
export interface WavelengthSpec {
  kind: 'wavelength';
  wavelength: Quantity; // 例: { value: 632.8, unit: 'nm' }
  medium: 'air' | 'vacuum';
}
export interface IncidenceGeometry {
  kind: 'incidence_geometry';
  theta: Quantity; // 入射角
  azimuth: Quantity; // 方位角
  frame: Frame;
}
export interface CalibrationPlane {
  kind: 'calibration_plane';
  // z = a*x + b*y + c，系数带单位（nm / px）
  a: Quantity;
  b: Quantity;
  c: Quantity;
  frame: Frame;
}
export interface CutEdit {
  seq: number;
  op: 'add_cut' | 'remove_cut';
  path: [number, number][]; // 像素坐标折线
  offsetCycles: number; // 切口两侧显式整周偏移
  author: string;
  note?: string;
}
export interface CutEditHistory {
  kind: 'cut_edits';
  edits: CutEdit[]; // 只追加，不覆盖
}

export type InputContent =
  | WrappedPhaseFrame
  | SnrScoresFrame
  | InvalidMaskFrame
  | WavelengthSpec
  | IncidenceGeometry
  | CalibrationPlane
  | CutEditHistory;

// ---- 决定实体（一等数据：候选、拒绝原因、未知状态）----
export type DecisionType =
  | 'accept_candidate'
  | 'reject_candidate'
  | 'lock_region' // 锁定局部解
  | 'unlock_region'
  | 'adjust_params'
  | 'resolve_conflict'
  | 'revert_decision'; // 撤销也写入历史

// ---- 派生实体 ----
export const DERIVATION_KINDS = [
  'quality_gate', // 低振幅门限结果（未知区不得猜相位）
  'region_map', // 多连通区标号
  'residue_map', // 残差点（+/- 电荷）
  'cut_network', // 切口网络（含显式整周偏移）
  'unwrap_candidate', // 某棵展开树得到的候选解（含路径）
  'cycle_residuals', // 循环残差
  'height_map', // 高度转换链终产物
] as const;
export type DerivationKind = (typeof DERIVATION_KINDS)[number];

export interface SourceRef {
  inputId: string; // 例: main/wavelength
  version: number;
  hash: string; // 内容摘要（sha256）
}

export type DerivationStatus = 'current' | 'stale' | 'rejected' | 'superseded';

// ---- 反例档案的七个情形 ----
export const SCENARIOS = [
  'phase_crossing_boundary', // 相位跨越边界
  'low_amplitude_holes', // 低振幅孔洞
  'multi_connected', // 多连通区
  'cycle_nonclosure', // 循环不闭合
  'wavelength_version_change', // 波长版本变更
  'integer_ambiguity', // 整周多解
  'local_lock_conflict', // 局部锁定冲突
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

// ---- 事件（机器可读取）----
export interface DomainEvent {
  seq: number;
  id: string; // evt_000001
  type: string;
  at: string; // ISO 时间（测试中为虚拟时间）
  actor: string;
  payload: Record<string, unknown>;
}

export interface UnwrapParams {
  qualityThreshold: number; // 低振幅门限：低于此值不得猜相位
  seed: number; // 固定 seed，决定树形/配对平局
  neighborOrder: 'xy' | 'yx';
}

export const DEFAULT_PARAMS: UnwrapParams = {
  qualityThreshold: 0.2,
  seed: 20260919,
  neighborOrder: 'xy',
};

export const ALGORITHM_VERSION = 'unwrap-1.2.0';
