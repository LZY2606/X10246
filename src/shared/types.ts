/**
 * 领域词汇表：数据契约直接使用光学干涉/相位展开的术语，
 * 不把领域量压成 name/value。
 */

export type InputKind =
  | 'wrapped-phase'        // 原相位像素（包裹相位）
  | 'signal-quality'       // 信噪评分
  | 'invalid-mask'         // 无效遮罩
  | 'wavelength'           // 波长
  | 'incidence-geometry'   // 入射几何
  | 'calibration-plane'    // 标定面
  | 'cut-edit-history';    // 切口编辑历史

export const INPUT_KINDS: InputKind[] = [
  'wrapped-phase',
  'signal-quality',
  'invalid-mask',
  'wavelength',
  'incidence-geometry',
  'calibration-plane',
  'cut-edit-history'
];

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  'wrapped-phase': '原相位像素',
  'signal-quality': '信噪评分',
  'invalid-mask': '无效遮罩',
  'wavelength': '波长',
  'incidence-geometry': '入射几何',
  'calibration-plane': '标定面',
  'cut-edit-history': '切口编辑历史'
};

/** 原相位像素：包裹相位，单位 rad，坐标基准为像素网格 */
export interface WrappedPhaseField {
  kind: 'wrapped-phase';
  width: number;
  height: number;
  unit: 'rad';
  coordinateFrame: 'pixel-grid';
  pixels: number[];
}

/** 信噪评分：线性 SNR，逐像素 */
export interface SignalQualityField {
  kind: 'signal-quality';
  width: number;
  height: number;
  unit: 'linear-snr';
  scores: number[];
}

/** 无效遮罩：1 = 无效 */
export interface InvalidMask {
  kind: 'invalid-mask';
  width: number;
  height: number;
  pixels: Array<0 | 1>;
}

/** 波长：携带单位与介质基准 */
export interface WavelengthSpec {
  kind: 'wavelength';
  value: number;
  unit: 'nm';
  medium: 'air' | 'vacuum';
}

/** 入射几何：入射角与参考轴 */
export interface IncidenceGeometry {
  kind: 'incidence-geometry';
  angleDeg: number;
  axis: 'x' | 'y';
  reference: 'optical-axis';
}

/** 标定面：由标定帧拟合的平面，单位 nm */
export interface CalibrationPlane {
  kind: 'calibration-plane';
  unit: 'nm';
  tiltX: number;
  tiltY: number;
  piston: number;
  reference: 'calibration-frame';
}

/** 切口编辑：在像素网格上添加/移除一段切口 */
export interface CutEdit {
  op: 'add' | 'remove';
  ax: number;
  ay: number;
  bx: number;
  by: number;
  note?: string;
}

/** 切口编辑历史：只追加，不可覆盖 */
export interface CutEditHistory {
  kind: 'cut-edit-history';
  edits: CutEdit[];
}

export type InputContent =
  | WrappedPhaseField
  | SignalQualityField
  | InvalidMask
  | WavelengthSpec
  | IncidenceGeometry
  | CalibrationPlane
  | CutEditHistory;

/** 诊断代码：七种验收情形 + 切口一致性 */
export type DiagnosticCode =
  | 'phase_crosses_boundary'
  | 'low_amplitude_hole'
  | 'multiply_connected_region'
  | 'cycle_not_closed'
  | 'wavelength_version_changed'
  | 'integer_multi_solution'
  | 'lock_conflict'
  | 'cut_inconsistent';

export const DIAGNOSTIC_LABELS: Record<DiagnosticCode, string> = {
  phase_crosses_boundary: '相位跨越边界',
  low_amplitude_hole: '低振幅孔洞',
  multiply_connected_region: '多连通区',
  cycle_not_closed: '循环不闭合',
  wavelength_version_changed: '波长版本变更',
  integer_multi_solution: '整周多解',
  lock_conflict: '局部锁定冲突',
  cut_inconsistent: '切口与循环残差不一致'
};
