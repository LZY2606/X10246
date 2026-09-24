/**
 * 干涉条纹簿 领域词汇与数据契约。
 * 刻意使用本领域词汇（包裹相位/整周/残差点/支路切口/标定面…），
 * 而不是把一切压成 name/value。
 */

// ---------- 单位与坐标基准 ----------
export type LengthUnit = "nm" | "um" | "mm" | "m";
export type AngleUnit = "rad" | "turn";
export type CoordFrame = "pixel" | "lab_xyz" | "camera_image";

export interface Quantity {
  value: number | number[];
  unit: string;
  datum?: string;
  /** 导入时的原始表示，派生层才做规范化；无法转换的值原样保留。 */
  rawRepresentation: string;
  conversionDiagnostic?: string;
}

export interface Grid2D {
  rows: number;
  cols: number;
  /** 行主序扁平数组，长度 rows*cols；缺失用 NaN，绝不猜测填充。 */
  data: number[];
  unit: string;
  coordinateFrame: CoordFrame;
}

// ---------- 七类不可覆盖的输入实体 ----------
export type InputEntityKind =
  | "wrapped_phase" // 原相位像素（包裹相位）
  | "amplitude" // 振幅
  | "snr_score" // 信噪评分
  | "invalid_mask" // 无效遮罩
  | "wavelength" // 波长
  | "incidence_geometry" // 入射几何
  | "calibration_plane" // 标定面
  | "cut_edit_history"; // 切口编辑历史（随审阅追加，已提交版本仍不可覆盖）

export interface InputEntity {
  kind: InputEntityKind;
  payload: unknown;
  unit?: string;
  datum?: string;
  rawRepresentation: string;
}

/** 输入一经提交不可覆盖；修订以新版本 + 父版本关系表达。 */
export interface VersionEntity {
  versionId: string;
  entityId: string;
  kind: InputEntityKind;
  parentVersionId: string | null;
  versionNo: number;
  createdAtTick: number;
  createdBy: string;
  unit: string | null;
  datum: string | null;
  rawRepresentation: string;
  payload: unknown;
  contentDigest: string;
  revisionNote: string;
}

/** 最小输入与组合输入共享的原始片段只存一份不可变内容。 */
export interface RawFragment {
  fragmentId: string;
  contentDigest: string;
  rawRepresentation: string;
  mediaType: string;
  byteLength: number;
}

export type ActionKind =
  | "project_created"
  | "input_committed"
  | "params_revised"
  | "source_patched_local"
  | "candidates_generated"
  | "cut_edited"
  | "cycle_residuals_evaluated"
  | "height_converted"
  | "local_lock_set"
  | "lock_conflict_detected"
  | "decision_made"
  | "rolled_back"
  | "archive_judged"
  | "case_replayed";

export interface MachineEvent {
  rule: string;
  subject: string;
  object: string;
  outcome: "observed" | "accepted" | "rejected" | "unknown" | "conflict" | "expired";
  reasonCode: string;
  detail?: Record<string, unknown>;
}

export interface LedgerEvent {
  eventId: string;
  seq: number;
  tick: number;
  actor: string;
  action: ActionKind;
  /** 该事件直接引用的输入/规则/决定版本；历史重放按它恢复，绝不退回最新版。 */
  refs: string[];
  paramsFingerprint: string | null;
  payload: unknown;
  machineEvents: MachineEvent[];
  parentEventId: string | null;
}

// ---------- 相位展开领域结构 ----------
export interface PixelId {
  r: number;
  c: number;
}

export interface PhaseEdge {
  edgeId: string;
  a: PixelId;
  b: PixelId;
  /** 包裹差分（rad）。 */
  wrappedDelta: number;
  /** 展开后整周偏移 k：a->b 的 unwrap(b)-unwrap(a) 修正整周数。 */
  wrapCount: number;
  isCut: boolean;
  /** 低振幅/被遮罩边不参与求解，整周偏移保持 unknown。 */
  unknown: boolean;
  confidence: number;
}

export interface ResiduePlaquette {
  plaquetteId: string;
  tl: PixelId;
  charge: -1 | 0 | 1;
  wrappedSum: number;
}

export interface CycleResidual {
  cycleId: string;
  /** 经过的 edgeId 有序闭合路径。 */
  path: string[];
  /** 闭合环绕整周残差（个整周）；非零即“循环不闭合”。 */
  residualTurns: number;
  closed: boolean;
  status: "closed" | "non_closed" | "indeterminate";
  sourceTreeId: string;
}

export interface IntegerCandidate {
  candidateId: string;
  edgeId: string;
  /** 该边上合法的整周偏移取值集合。 */
  wrapCountValues: number[];
  legal: boolean;
  rejectReason?: string;
  ambiguityGroup: string;
}

export interface UnwrapTreeResult {
  resultId: string;
  treeId: string;
  algorithmVersion: string;
  paramsFingerprint: string;
  directSources: string[];
  grid: Grid2D;
  edges: PhaseEdge[];
  plaquettes: ResiduePlaquette[];
  candidates: IntegerCandidate[];
  cycleResiduals: CycleResidual[];
  /** 低振幅/遮罩像素显式标记为未展开，不猜相位。 */
  unresolvedPixels: PixelId[];
  status: "current" | "expired" | "historical";
  createdAtEventId: string;
}

export interface HeightStage {
  stageId: string;
  name: string;
  formula: string;
  inputs: string[];
  unit: string;
}

export interface HeightChainResult {
  resultId: string;
  unwrapResultId: string;
  wavelengthVersionId: string;
  geometryVersionId: string;
  calibrationVersionId: string;
  algorithmVersion: string;
  paramsFingerprint: string;
  chain: HeightStage[];
  heightGrid: Grid2D;
  status: "current" | "expired" | "historical";
  createdAtEventId: string;
}

export interface LocalLock {
  lockId: string;
  pixel: PixelId;
  /** 锁定的整周解读（绝对整周层）。 */
  wrapCount: number;
  sourceResultId: string;
  owner: string;
  createdAtTick: number;
  active: boolean;
  conflict: boolean;
}

// ---------- 反例档案 ----------
export type AdversaryScenario =
  | "phase_boundary_crossing"
  | "low_amplitude_hole"
  | "multiply_connected_region"
  | "cycle_non_closure"
  | "wavelength_version_change"
  | "integer_multiplicity"
  | "local_lock_conflict";

export interface AdversaryCase {
  scenario: AdversaryScenario;
  minimalFragmentIds: string[];
  combinedFragmentIds: string[];
  changedDirectSource: string | null;
  expectedScope: string[];
  adoptedResultId: string | null;
  rejectedResultIds: string[];
  interpretations: string[];
  failureDiagnostics: string[];
  humanDecisions: string[];
  judgments: MachineEvent[];
}

// ---------- 损坏诊断 ----------
export interface IntegrityDiagnostic {
  code:
    | "MISSING_REFERENCE"
    | "DANGLING_VERSION_REF"
    | "IMMUTABLE_OVERWRITE"
    | "IMPORT_FORMAT_ERROR";
  ref: string;
  message: string;
}
