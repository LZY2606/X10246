/**
 * 领域数据契约：直接使用光学干涉/相位展开/标定词汇，不压成 name/value。
 * 所有层共享这些类型；原始输入一经提交不可覆盖，修订以新版本+父版本表达。
 */

export const INPUT_KINDS = [
  'WrappedPhaseField',
  'QualityScoreField',
  'InvalidMask',
  'WavelengthSpec',
  'IncidenceGeometry',
  'CalibrationSurface',
  'CutEditHistory',
] as const
export type InputKind = (typeof INPUT_KINDS)[number]

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  WrappedPhaseField: '原相位像素（包裹相位）',
  QualityScoreField: '信噪评分',
  InvalidMask: '无效遮罩',
  WavelengthSpec: '波长',
  IncidenceGeometry: '入射几何',
  CalibrationSurface: '标定面',
  CutEditHistory: '切口编辑历史',
}

export interface GridCoordinates {
  origin: [number, number]
  spacing: [number, number]
  unit: string
}

export interface WrappedPhaseField {
  kind: 'WrappedPhaseField'
  width: number
  height: number
  unit: 'rad'
  range: [number, number]
  coordinates: GridCoordinates
  pixels: number[]
}

export interface QualityScoreField {
  kind: 'QualityScoreField'
  width: number
  height: number
  unit: 'ratio'
  metric: 'snr-normalized' | 'amplitude-normalized'
  coordinates: GridCoordinates
  scores: number[]
}

export interface InvalidMask {
  kind: 'InvalidMask'
  width: number
  height: number
  semantics: '1=invalid'
  coordinates: GridCoordinates
  masked: number[]
}

export interface WavelengthSpec {
  kind: 'WavelengthSpec'
  value: number
  unit: string
  source: string
}

export interface IncidenceGeometry {
  kind: 'IncidenceGeometry'
  mode: 'reflection' | 'transmission'
  angle_deg: number
}

export interface CalibrationSurface {
  kind: 'CalibrationSurface'
  model: 'plane'
  coeffs: { a: number; b: number; c: number }
  unit: string
  coordinates: GridCoordinates
}

export interface CutEdit {
  op: 'add-cut' | 'remove-cut'
  edge: [number, number]
  note?: string
}

export interface CutEditHistory {
  kind: 'CutEditHistory'
  width: number
  height: number
  edits: CutEdit[]
}

export type InputContent =
  | WrappedPhaseField
  | QualityScoreField
  | InvalidMask
  | WavelengthSpec
  | IncidenceGeometry
  | CalibrationSurface
  | CutEditHistory

/** 七个验收反例场景 */
export const SCENARIOS = [
  { id: 'phase-cross-boundary', title: '相位跨越边界' },
  { id: 'low-amplitude-hole', title: '低振幅孔洞' },
  { id: 'multi-connected-region', title: '多连通区' },
  { id: 'cycle-nonclosure', title: '循环不闭合' },
  { id: 'wavelength-version-change', title: '波长版本变更' },
  { id: 'integer-ambiguity', title: '整周多解' },
  { id: 'local-lock-conflict', title: '局部锁定冲突' },
] as const
export type ScenarioId = (typeof SCENARIOS)[number]['id']

/** 机器可读取的判断依据规则 */
export const JUDGEMENT_RULES = {
  'low-amplitude-no-guess': '低振幅区域不得猜相位',
  'explicit-cut-offset': '切口两侧的整周偏移要显式表示',
  'tree-path-residuals': '不同展开树可得到局部一致解，需保留路径与循环残差',
} as const
export type JudgementRule = keyof typeof JUDGEMENT_RULES

export const DIAGNOSTIC_CODES = [
  'LOW_AMPLITUDE_NO_GUESS',
  'PHASE_WRAP_CROSSING',
  'MULTI_CONNECTED',
  'CYCLE_NONCLOSURE',
  'INTEGER_AMBIGUITY',
  'UNIT_UNCONVERTIBLE',
  'STALE_DEPENDENCY',
] as const

export interface Diagnostic {
  code: (typeof DIAGNOSTIC_CODES)[number]
  severity: 'info' | 'warning' | 'error'
  message: string
  data?: unknown
}

export type DecisionType =
  | 'adopt'
  | 'reject'
  | 'lock'
  | 'resolve-conflict'
  | 'undo'
  | 'adjust-param'

export function isInputKind(x: string): x is InputKind {
  return (INPUT_KINDS as readonly string[]).includes(x)
}
