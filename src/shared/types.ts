/**
 * 领域数据契约：直接使用光学干涉 / 相位展开 / 标定词汇。
 * 所有量都携带单位（unit）与坐标基准（basis）。
 */

export type Unit = 'rad' | 'deg' | 'nm' | 'um' | 'angstrom' | 'count' | 'dimensionless';

export interface Diagnostic {
  code: string;
  message: string;
  at?: string;
}

export interface Quantity<T = number> {
  value: T;
  unit: Unit;
  /** 坐标基准，例如 'pixel-grid:row-major:origin-top-left' 或 'optical-axis:lab-frame' */
  basis?: string;
}

export type Grid = number[][];
export type MaskGrid = boolean[][];
export type Pixel = [row: number, col: number];

/* ---------- 输入实体（原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史） ---------- */

export interface WrappedPhaseFrame {
  kind: 'wrapped_phase';
  /** 包裹相位像素，单位 rad，范围 (-π, π] */
  pixels: Quantity<Grid>;
}

export interface AmplitudeFrame {
  kind: 'amplitude';
  /** 干涉振幅（信噪评分来源），单位 count */
  pixels: Quantity<Grid>;
}

export interface InvalidMask {
  kind: 'invalid_mask';
  mask: MaskGrid;
}

export interface WavelengthSpec {
  kind: 'wavelength';
  wavelength: Quantity<number>;
}

export interface IncidenceGeometry {
  kind: 'incidence_geometry';
  thetaIncidence: Quantity<number>;
  thetaReflection: Quantity<number>;
  basis: string;
}

export interface CalibrationPlane {
  kind: 'calibration_plane';
  /** plane(r,c) = c0 + cr*r + cc*c，单位与 heightUnit 一致 */
  coefficients: Quantity<[number, number, number]>;
  basis: string;
}

export interface CutEdit {
  op: 'add' | 'remove';
  edge: { a: Pixel; b: Pixel };
  note?: string;
}

export interface CutEditHistory {
  kind: 'cut_edit_history';
  edits: CutEdit[];
}

export type RawContent =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | InvalidMask
  | WavelengthSpec
  | IncidenceGeometry
  | CalibrationPlane
  | CutEditHistory;

export type RawKind = RawContent['kind'];

export const RAW_KINDS: RawKind[] = [
  'wrapped_phase',
  'amplitude',
  'invalid_mask',
  'wavelength',
  'incidence_geometry',
  'calibration_plane',
  'cut_edit_history',
];

/* ---------- 版本化引用：任何引用都必须显式携带版本与内容摘要 ---------- */

export interface Ref {
  id: string;
  version: number;
  digest: string;
}

export interface RawInputEnvelope {
  id: string;
  kind: RawKind;
  version: number;
  /** 父版本 "id@version"，首版为 null */
  parent: string | null;
  digest: string;
  /** 原始表示，未经规范化；或 { $fragment: digest } 指向共享不可变片段 */
  content: RawContent | { $fragment: string };
  provenance: { source: 'import' | 'case-package' | 'revision' | 'scenario'; note?: string };
  logicalTime: number;
}

/* ---------- 决定实体（解释 / 派生结果） ---------- */

export type InterpretationKind =
  | 'quality_map'
  | 'residue_map'
  | 'cut_network'
  | 'unwrap_candidate'
  | 'cycle_residual_report'
  | 'height_map'
  | 'lock_state';

export type InterpretationStatus = 'current' | 'expired' | 'accepted' | 'rejected' | 'unknown';

export interface Interpretation {
  id: string;
  bundleId: string;
  kind: InterpretationKind;
  algorithmVersion: string;
  paramFingerprint: string;
  /** 直接来源：原始输入或上游解释的显式版本引用 */
  sources: Ref[];
  status: InterpretationStatus;
  payload: unknown;
  diagnostics: Diagnostic[];
  logicalTime: number;
}

/* ---------- 决定实体的领域负载 ---------- */

export interface QualityMapPayload {
  score: Grid;
  /** 低振幅 / 无效像素：不得猜相位 */
  unknown: MaskGrid;
  holes: Pixel[];
  threshold: number;
}

export interface ResidueMapPayload {
  /** 每个 plaquette 的残差（-1|0|1），null 表示未知 */
  residues: (number | null)[][];
  cycles: { plaquette: Pixel; residual: number; path: Pixel[] }[];
}

export interface CutEdge {
  a: Pixel;
  b: Pixel;
}

export interface CutNetworkPayload {
  cuts: CutEdge[];
  pairs: { positive: Pixel; negative: Pixel | 'boundary' }[];
  manualEdits: CutEdit[];
}

export interface UnwrapCandidatePayload {
  seed: Pixel;
  /** 展开相位；null = 未知（低振幅区域不得猜相位） */
  phase: (number | null)[][];
  phaseUnit: 'rad';
  /** 切口两侧的整周偏移，显式表示 */
  kOffsets: { edge: CutEdge; k: number }[];
  /** 展开树路径（不同展开树可得到局部一致解，需保留路径） */
  tree: { from: Pixel; to: Pixel }[];
  regions: { id: number; pixelCount: number }[];
  /** 整周多解：不连通区域间的自由整数 */
  freeIntegers: { region: number; shift: number; note: string }[];
  cycleResiduals: { plaquette: Pixel; residual: number }[];
}

export interface CycleResidualReportPayload {
  candidateId: string;
  residuals: { plaquette: Pixel; residual: number; path: Pixel[] }[];
  closed: boolean;
}

export interface HeightMapPayload {
  candidateId: string;
  /** 表面高度，null = 未知 */
  height: (number | null)[][];
  heightUnit: 'nm';
  basis: string;
  /** 高度转换链：波长版本 → 入射几何 → 标定面 → 候选 */
  chain: { stage: string; ref: Ref }[];
}

export interface LockStatePayload {
  candidateId: string;
  region: { r0: number; c0: number; r1: number; c1: number };
  kOffset: number;
  reviewer: string;
}

/* ---------- 机器可读取事件 ---------- */

export type EventType =
  | 'raw.imported'
  | 'raw.revised'
  | 'bundle.defined'
  | 'derived.candidates'
  | 'interpretation.expired'
  | 'candidate.accepted'
  | 'candidate.rejected'
  | 'region.locked'
  | 'lock.conflict'
  | 'conflict.resolved'
  | 'event.undone'
  | 'scenario.recorded'
  | 'archive.exported'
  | 'archive.imported';

/** 判断依据（机器可读） */
export type JudgmentBasis =
  | 'low-amplitude-no-guess'
  | 'explicit-cut-offset'
  | 'path-and-cycle-residual'
  | 'local-consistency-multiple-trees'
  | 'wavelength-version-pinning'
  | 'lock-conflict-overlap';

export interface DomainEvent {
  seq: number;
  id: string;
  type: EventType;
  refs: Ref[];
  payload: unknown;
  logicalTime: number;
}

export interface Bundle {
  id: string;
  members: Ref[];
  logicalTime: number;
}

export interface Archive {
  format: 'fringe-book-archive/1';
  exportedAt: number;
  fragments: { digest: string; content: unknown }[];
  rawInputs: RawInputEnvelope[];
  interpretations: Interpretation[];
  bundles: Bundle[];
  events: DomainEvent[];
}
