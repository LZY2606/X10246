/**
 * 数据契约：直接使用光学干涉/相位展开/标定领域词汇，
 * 不压成通用 name/value。
 */

export const INPUT_KINDS = [
  'raw_phase_pixels',
  'snr_score',
  'invalid_mask',
  'wavelength',
  'incidence_geometry',
  'calibration_surface',
  'cut_edit_history',
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  raw_phase_pixels: '原相位像素',
  snr_score: '信噪评分',
  invalid_mask: '无效遮罩',
  wavelength: '波长',
  incidence_geometry: '入射几何',
  calibration_surface: '标定面',
  cut_edit_history: '切口编辑历史',
};

export const SCENARIO_KINDS = [
  'phase_boundary_crossing',
  'low_amplitude_hole',
  'multi_connected_region',
  'cycle_nonclosure',
  'wavelength_version_change',
  'integer_ambiguity_multi',
  'local_lock_conflict',
] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export const SCENARIO_LABELS: Record<ScenarioKind, string> = {
  phase_boundary_crossing: '相位跨越边界',
  low_amplitude_hole: '低振幅孔洞',
  multi_connected_region: '多连通区',
  cycle_nonclosure: '循环不闭合',
  wavelength_version_change: '波长版本变更',
  integer_ambiguity_multi: '整周多解',
  local_lock_conflict: '局部锁定冲突',
};

/** 网格：行主序，坐标基准为像素坐标 */
export interface Grid {
  width: number;
  height: number;
  data: number[];
}

/** 带单位与坐标基准的领域量 */
export interface DomainQuantity {
  unit: string;
  coordFrame: string;
}

export interface GridQuantity extends DomainQuantity {
  grid: Grid;
}

export interface ScalarQuantity extends DomainQuantity {
  value: number;
}

export interface PlaneQuantity extends DomainQuantity {
  /** 标定面：z(x,y) = a*x + b*y + c */
  a: number;
  b: number;
  c: number;
}

export interface IncidenceGeometry extends DomainQuantity {
  /** 入射角（度），反射式干涉 */
  thetaDeg: number;
  geometry: 'reflection' | 'transmission';
}

export interface CutEditEntry {
  op: 'add_cut' | 'remove_cut';
  ax: number;
  ay: number;
  bx: number;
  by: number;
  note?: string;
}

export interface CutEditHistory extends DomainQuantity {
  entries: CutEditEntry[];
}

export type DerivationStatus = 'current' | 'expired' | 'failed' | 'unknown';
export type CandidateState = 'pending' | 'adopted' | 'rejected' | 'locked' | 'conflicted';
export type LockState = 'active' | 'conflicted' | 'released';
export type DecisionAction =
  | 'accept_candidate'
  | 'reject_candidate'
  | 'lock_region'
  | 'unlock_region'
  | 'adjust_params'
  | 'undo';

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  detail?: unknown;
}

export const EVENT_TYPES = [
  'casepack_seeded',
  'input_submitted',
  'derivation_computed',
  'derivation_expired',
  'candidate_adopted',
  'candidate_rejected',
  'region_locked',
  'region_unlocked',
  'lock_conflict',
  'params_adjusted',
  'decision_undone',
  'archive_exported',
  'archive_imported',
  'store_reset',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
