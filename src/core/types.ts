/**
 * 数据契约：直接采用光学干涉 / 相位展开 / 标定领域自己的词汇。
 * 不使用通用 name/value 压扁结构。
 *
 * 不可变输入实体（原始输入一经提交不可覆盖，修订以新版本+父版本表达）：
 *   WrappedPhaseField 原相位像素
 *   SnrScoreField     信噪评分
 *   AmplitudeField    振幅
 *   ValidityMask      无效遮罩
 *   Wavelength        波长
 *   IlluminationGeometry 入射几何
 *   CalibrationPlane  标定面
 *   CalibrationFrameSet 标定帧
 *   CutEditHistory    切口编辑历史（只追加）
 *
 * 决定实体（候选 / 拒绝原因 / 未知状态均为一等数据）：
 *   QualityMap / ResidueMap / BranchCutNetwork / UnwrapForest /
 *   CycleResidualSet / IntegerOffsetCandidates / HeightField
 *
 * 复核实体：LocalInterpretationLock / ReviewDecision / ReviewEvent。
 */

export const SCHEMA_VERSION = "1.0";

export type GridEncoding = "f64" | "u8" | "bits";

/** 网格片段引用：大数组只存一份不可变内容，实体只引用。 */
export interface GridFragmentRef {
  kind: "gridFragment";
  fragmentId: string;
  encoding: GridEncoding;
  width: number;
  height: number;
  /** 片段内容的 sha256，引用缺失或校验不符即损坏。 */
  digest: string;
}

export interface GridFragment extends GridFragmentRef {
  /** f64/u8 为数字数组（逐行）；bits 为 "0"/"1" 字符串（逐行，"1"=有效）。 */
  data: number[] | string;
}

export interface RecordRef {
  streamId: string;
  version: number;
  digest: string;
}

export interface AlgorithmProvenance {
  algorithmName: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  parameters: Record<string, unknown>;
  directSources: RecordRef[];
}

export type EntityKind =
  | "wrappedPhaseField"
  | "snrScoreField"
  | "amplitudeField"
  | "validityMask"
  | "wavelength"
  | "illuminationGeometry"
  | "calibrationPlane"
  | "calibrationFrameSet"
  | "cutEditHistory"
  | "qualityMap"
  | "residueMap"
  | "branchCutNetwork"
  | "unwrapForest"
  | "cycleResidualSet"
  | "integerOffsetCandidates"
  | "heightField"
  | "localInterpretationLock"
  | "reviewDecision";

export type EntityStatus = "current" | "stale" | "superseded";

export interface EntityRecord<TPayload = unknown> {
  streamId: string;
  version: number;
  kind: EntityKind;
  digest: string;
  parentRef: RecordRef | null;
  status: EntityStatus;
  /** 逻辑时钟（虚拟时间），导入与重放完全确定。 */
  committedAt: number;
  /** 原始输入无算法出处；派生值必须有。 */
  provenance: AlgorithmProvenance | null;
  payload: TPayload;
}

// ---------- 原始不可变输入实体 ----------

export interface WrappedPhaseField {
  label: string;
  phase: GridFragmentRef;
  /** 原始表示（导入时保留，派生层才规范化）。 */
  rawRepresentation: { unit: "rad"; convention: "principal(-pi,pi]" };
  coordinateFrameId: string;
}

export interface SnrScoreField {
  label: string;
  scores: GridFragmentRef;
  rawRepresentation: { unit: "1", range: "[0,1] 越大越可信" };
  coordinateFrameId: string;
}

export interface AmplitudeField {
  label: string;
  amplitude: GridFragmentRef;
  rawRepresentation: { unit: string; note: string };
  coordinateFrameId: string;
}

export interface ValidityMask {
  label: string;
  validBits: GridFragmentRef;
  semantics: { valid: "1"; invalid: "0"; invalidReason: string };
  coordinateFrameId: string;
}

export interface Wavelength {
  label: string;
  value: number;
  unit: string;
  /** 版本变更原因（v1 之后由修订事件携带；首版可空）。 */
  revisionNote: string | null;
}

export interface IlluminationGeometry {
  label: string;
  model: "reflection-off-axis";
  /** 入射角（相对表面法线）。 */
  incidenceAngle: { value: number; unit: "deg" };
  /** 入射面方位角。 */
  azimuthAngle: { value: number; unit: "deg" };
  convention: string;
}

export interface CalibrationPlane {
  label: string;
  /** 平面 z = a*x + b*y + c，坐标基准与单位显式给出。 */
  coefficients: { a: number; b: number; c: number };
  coordinateFrameId: string;
  unit: string;
}

export interface CalibrationFrameSet {
  label: string;
  poses: Array<{
    poseId: string;
    phase: GridFragmentRef;
    amplitude: GridFragmentRef;
    note: string;
  }>;
}

export type CutOp =
  | { type: "addCut"; edge: PixelEdge; reason: string }
  | { type: "removeCut"; edge: PixelEdge; reason: string };

export interface CutEditEntry extends CutOp {
  editId: string;
  author: string;
  logicalClock: number;
}

export interface CutEditHistory {
  label: string;
  /** 只追加的切口编辑历史；导入的种子历史同样不可覆盖。 */
  entries: CutEditEntry[];
}

export interface PixelEdge {
  /** 像素邻接边（切口两侧）。 */
  a: PixelCoord;
  b: PixelCoord;
}

export interface PixelCoord {
  r: number;
  c: number;
}

// ---------- 派生（决定）实体 ----------

export interface QualityMapPayload {
  label: string;
  quality: GridFragmentRef;
  unknownBits: GridFragmentRef;
  unknownReasons: Array<{ at: PixelCoord; reason: string }>;
  /** 低振幅区域不得猜相位/质量：显式未知，不插值。 */
  lowAmplitudeFloor: number;
}

export type ResidueCharge = -1 | 0 | 1;

export interface ResidueMapPayload {
  label: string;
  /** 每个 2x2 小环一个电荷；尺寸 (height-1) x (width-1)。 */
  charges: GridFragmentRef;
  unknownPlaquettes: PixelCoord[];
  fringeSignConvention: "positive-charge=+2pi-winding";
}

export interface BranchCutNetworkPayload {
  label: string;
  cuts: PixelEdge[];
  residueLinks: Array<{ from: PixelCoord; to: PixelCoord | "image-border"; charge: ResidueCharge }>;
  source: "goldstein-deterministic" | "manual-edit" | "auto+manual";
}

export interface ForestEdge {
  parent: PixelCoord;
  child: PixelCoord;
  /** 该树边上使用的 2π 整周数。 */
  wrapCount: number;
  /** 包裹增量（rad，原始）。 */
  wrappedIncrement: number;
}

export interface UnwrapForestPayload {
  label: string;
  width: number;
  height: number;
  components: Array<{
    componentId: string;
    anchor: PixelCoord;
    pixels: PixelCoord[];
    edges: ForestEdge[];
  }>;
  unwrappedPhase: GridFragmentRef;
  unknownBits: GridFragmentRef;
}

export interface CycleResidual {
  loopId: string;
  loop: PixelCoord[];
  residualRad: number | null;
  closed: boolean;
  toleranceRad: number;
  diagnostic: string | null;
}

export interface CycleResidualSetPayload {
  label: string;
  cycles: CycleResidual[];
}

export interface IntegerCandidate {
  candidateId: string;
  edge: PixelEdge;
  wrapOffset: number;
  adopted: boolean;
  legal: boolean;
  evidence: string;
  rejectionReason: string | null;
}

export interface IntegerOffsetCandidatesPayload {
  label: string;
  candidates: IntegerCandidate[];
  /** 无法唯一决定时保留全部合法候选。 */
  unresolvedEdges: PixelEdge[];
}

export interface HeightFieldPayload {
  label: string;
  height: GridFragmentRef;
  unknownBits: GridFragmentRef;
  unknownReasons: Array<{ at: PixelCoord; reason: string }>;
  conversionChain: {
    phase: RecordRef;
    wavelength: RecordRef;
    geometry: RecordRef;
    calibrationPlane: RecordRef;
    formula: "h = lambda * phi_unwrapped / (4*pi*cos(theta)) - (a*x+b*y+c)";
    outputUnit: string;
  };
}

// ---------- 复核实体 ----------

export type LockState = "proposed" | "active" | "conflicted" | "superseded" | "released";

export interface LocalInterpretationLockPayload {
  label: string;
  region: { pixels: PixelCoord[] };
  edge: PixelEdge | null;
  wrapOffset: number;
  state: LockState;
  lockedBy: string;
  conflictsWith: RecordRef | null;
  supersedes: RecordRef | null;
  note: string;
}

export type Adjudication = "accepted" | "rejected" | "parameter-adjusted";

export interface ReviewDecisionPayload {
  label: string;
  target: RecordRef;
  adjudication: Adjudication;
  rationale: string;
  parameterChanges: Record<string, unknown>;
  undone: boolean;
}

// ---------- 事件（机器可读取的判断依据） ----------

export type JudgmentCode =
  | "LOW_AMPLITUDE_NO_GUESS"
  | "CUT_INTEGER_OFFSET_EXPLICIT"
  | "MULTIPLE_UNWRAP_TREES_KEEP_PATHS_AND_CYCLE_RESIDUALS"
  | "PHASE_BOUNDARY_CROSSING"
  | "LOW_AMPLITUDE_HOLE"
  | "MULTIPLY_CONNECTED_REGION"
  | "CYCLE_NOT_CLOSED"
  | "WAVELENGTH_VERSION_CHANGED"
  | "INTEGER_MULTIPLE_SOLUTIONS"
  | "LOCAL_LOCK_CONFLICT"
  | "LOCAL_DEPENDENCY_INVALIDATED"
  | "REFERENCE_CORRUPT"
  | "UNCONVERTIBLE_UNIT_KEPT_IN_PLACE"
  | "DECISION_UNDONE";

export interface JudgmentEvent {
  code: JudgmentCode;
  holds: boolean | null;
  evidence: Record<string, unknown>;
}

export type ReviewEventType =
  | "project.imported"
  | "scenario.reviewed"
  | "derived.computed"
  | "derived.stale"
  | "source.revised"
  | "candidate.proposed"
  | "candidate.adjudicated"
  | "lock.proposed"
  | "lock.conflicted"
  | "lock.resolved"
  | "lock.released"
  | "decision.recorded"
  | "decision.undone"
  | "parameters.revised"
  | "archive.exported"
  | "archive.imported"
  | "reference.corrupt";

export interface ReviewEvent {
  eventId: string;
  seq: number;
  parentEventId: string | null;
  atVirtualIso: string;
  type: ReviewEventType;
  summary: string;
  refs: RecordRef[];
  affectedObjects: string[];
  judgment: JudgmentEvent | null;
  body: Record<string, unknown>;
}

export interface ProjectMeta {
  projectId: string;
  title: string;
  createdAtVirtualIso: string;
  scenarioIds: string[];
  seed: number;
}
