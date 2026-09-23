import type { CoordinateFrame, Quantity } from "./units.js";

// ---------------------------------------------------------------------------
// 基础载体
// ---------------------------------------------------------------------------

/** 二维栅格：扁平数组 + 行宽；非法像素用 null，不为画图而猜值。 */
export interface Grid2D {
  width: number;
  height: number;
  cells: (number | null)[];
}

export interface EntityRef {
  /** 被引用实体的稳定身份。 */
  entityId: string;
  /** 必须指向具体不可变版本；缺失/断链即损坏，不允许回退最新版。 */
  versionId: string;
  kind: string;
  /** 内容摘要，导入/重放时用于核验引用完整性。 */
  digest: string;
}

export interface AlgorithmProvenance {
  algorithm: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  /** 直接来源（不是传递来源）。 */
  sources: EntityRef[];
  seed: number;
}

// ---------------------------------------------------------------------------
// 输入实体：一经提交不可覆盖，修订以新版本 + 父版本关系表达
// ---------------------------------------------------------------------------

export type RawKind =
  | "wrapped_phase"
  | "amplitude"
  | "invalidity_mask"
  | "wavelength"
  | "illumination_geometry"
  | "calibration_plane";

export interface RawVersionBase {
  versionId: string;
  parentVersionId: string | null;
  revisionNote: string;
  /** 原始表示（数值+单位），规范化只在派生层。 */
  rawRepresentation: Record<string, unknown>;
  digest: string;
  createdAt: number;
}

/** 原相位像素：包裹相位 [-π,π) 栅格。 */
export interface WrappedPhaseFrame extends RawVersionBase {
  kind: "wrapped_phase";
  phase: Grid2D;
  phaseUnit: "rad";
  coordinateFrame: CoordinateFrame;
}

/** 振幅：同时作为信噪评分的来源。 */
export interface AmplitudeFrame extends RawVersionBase {
  kind: "amplitude";
  amplitude: Grid2D;
  amplitudeUnit: string;
}

/** 无效遮罩：true=无效（孔洞/遮挡/边界外）。 */
export interface InvalidityMask extends RawVersionBase {
  kind: "invalidity_mask";
  invalid: boolean[];
  reason: string[];
}

/** 波长（可修订，多波长版本的根）。 */
export interface WavelengthSpec extends RawVersionBase {
  kind: "wavelength";
  wavelength: Quantity;
  /** 合成波等多波长关系；单波长为空。 */
  syntheticFrom: { a: number; b: number } | null;
}

/** 入射几何：倾斜照明/观察方向。 */
export interface IlluminationGeometry extends RawVersionBase {
  kind: "illumination_geometry";
  /** 敏感度向量 k（每米相位对应的高度），角度与基线完整保留。 */
  incidenceAngle: Quantity;
  observationAngle: Quantity;
  sensitivityFactor: number;
}

/** 标定面：平面拟合/已知参考高度。 */
export interface CalibrationPlane extends RawVersionBase {
  kind: "calibration_plane";
  /** 平面 z = a*col + b*row + c（物理单位）。 */
  coefficients: { a: number; b: number; c: number };
  fitRms: number | null;
  referencePoints: { row: number; col: number; height: number }[];
}

export type RawVersion =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | InvalidityMask
  | WavelengthSpec
  | IlluminationGeometry
  | CalibrationPlane;

/** 不可覆盖实体头：同 entityId 的多个版本以父子链相连。 */
export interface RawEntity {
  entityId: string;
  kind: RawKind;
  /** 原始片段在 blobs 中只存一份；多个输入共享同一 blobId。 */
  blobId: string;
  versions: RawVersion[];
  /** 当前指针仅作展示便利；任何引用仍必须写死版本号。 */
  currentVersionId: string;
  importedAt: number;
}

// ---------------------------------------------------------------------------
// 派生实体：候选、拒绝原因、误差/未知状态都是一等数据
// ---------------------------------------------------------------------------

export type QualityClass = "high" | "usable" | "low" | "unknown";

export interface QualityCell {
  score: number | null;
  cls: QualityClass;
  /** 低振幅区域不得猜相位：未知原因显式保留。 */
  unknownReason: string | null;
}

export interface QualityMap {
  recordId: string;
  prov: AlgorithmProvenance;
  cells: QualityCell[];
  thresholdLow: number;
  thresholdHigh: number;
  createdAt: number;
}

export type ResidueCharge = 1 | -1;

export interface Residue {
  row: number;
  col: number;
  charge: ResidueCharge;
  wrappedSum: number;
}

export interface ResidueMap {
  recordId: string;
  prov: AlgorithmProvenance;
  residues: Residue[];
  createdAt: number;
}

/** 支路（branch cut）：连接残差点/边界，阻断跨越。 */
export interface CutEdge {
  id: string;
  a: { row: number; col: number };
  b: { row: number; col: number };
  /** 两侧整周偏移的显式表示；未唯一决定时为 null（候选另存）。 */
  offsetK: number | null;
  /** 自动 / 人工及操作者，可追溯到切口编辑历史。 */
  origin: "auto" | "manual";
  editedBy: string | null;
  /** 跨越低振幅孔洞/无效像素时为 true。 */
  crossesInvalid: boolean;
  residuesLinked: number;
}

export interface CutNetwork {
  recordId: string;
  prov: AlgorithmProvenance;
  edges: CutEdge[];
  /** 平衡失败即保留不平衡诊断，不假装闭合。 */
  balanced: boolean;
  balanceDiagnostic: string | null;
  createdAt: number;
}

export interface IntegerCandidate {
  id: string;
  target: { row: number; col: number };
  /** 全部合法 k 值；无法唯一决定时保留多个。 */
  k: number;
  accepted: boolean | null;
  rejectReason: string | null;
  confidence: number;
  /** 低振幅孔洞等导致只能给区间时为 true。 */
  ambiguous: boolean;
}

export interface CycleResidual {
  id: string;
  pixelLoop: { row: number; col: number }[];
  /** 沿环路的相位闭合误差（弧度）。 */
  residualRad: number;
  /** 等效整周数；非零即循环不闭合。 */
  wrapCount: number;
  closed: boolean;
  crossesCut: boolean;
  region: number;
}

export interface UnwrapTree {
  recordId: string;
  variantName: string;
  prov: AlgorithmProvenance;
  /** 展开树边（像素父子关系），不同展开树各自保留。 */
  parentEdge: (number | null)[];
  root: (number | null)[];
  regionOf: number[];
  /** 展开相位；孔洞/跨越未解处为 null。 */
  unwrapped: (number | null)[];
  candidates: IntegerCandidate[];
  cycles: CycleResidual[];
  locallyConsistent: boolean;
  createdAt: number;
}

export interface HeightMap {
  recordId: string;
  prov: AlgorithmProvenance;
  /** 高度转换链：相位 -> 光程差 -> 几何高度 -> 减标定面。 */
  chain: {
    phaseToOPDFactor: number;
    opdToHeightFactor: number;
    planeSubtracted: boolean;
  };
  height: (number | null)[];
  heightUnit: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 复核实体：锁定局部解读、人工决定、机器可读取判断事件
// ---------------------------------------------------------------------------

export interface LocalLock {
  lockId: string;
  region: { row: number; col: number }[];
  /** 锁定时引用的展开树版本、候选与高度版本（写死版本号）。 */
  treeRef: EntityRef;
  candidateId: string | null;
  heightRef: EntityRef | null;
  note: string;
  owner: string;
  placedAt: number;
  active: boolean;
  /** 锁定冲突（同一像素被不同整周解读锁定）在此显式记录。 */
  conflictWith: string[];
}

export type DecisionKind = "accept" | "reject" | "parameter_adjustment" | "conflict_resolution";
export type DecisionStatus = "adopted" | "not_adopted";

export interface JudgmentEvent {
  judgmentId: string;
  kind: DecisionKind;
  status: DecisionStatus;
  targetRef: EntityRef;
  rationale: string;
  operator: string;
  at: number;
  /** 被采纳与未采纳的结果都保留；未采纳也可回看。 */
  supersedesJudgmentId: string | null;
}

/** 机器可读取的规则判断依据（低振幅不猜、切口显式偏移、路径与残差）。 */
export interface RuleAssertion {
  code:
    | "LOW_AMPLITUDE_NO_GUESS"
    | "CUT_OFFSET_EXPLICIT"
    | "TREE_PATH_AND_CYCLE_RESIDUAL"
    | "MULTIPLE_LEGAL_CANDIDATES_KEPT";
  passed: boolean;
  detail: string;
  evidenceRefs: EntityRef[];
}

// ---------------------------------------------------------------------------
// 事件溯源
// ---------------------------------------------------------------------------

export type EventType =
  | "project_created"
  | "raw_imported"
  | "raw_revised"
  | "source_patched"
  | "cut_history_imported"
  | "quality_computed"
  | "residues_computed"
  | "cuts_computed"
  | "cuts_edited"
  | "unwrapped"
  | "height_computed"
  | "candidate_adjudicated"
  | "lock_placed"
  | "lock_conflict"
  | "conflict_resolved"
  | "decision_recorded"
  | "rolled_back";

export interface LedgerEvent {
  eventId: string;
  seq: number;
  type: EventType;
  at: number;
  operator: string;
  payload: Record<string, unknown>;
  /** 该命令直接依赖的版本（用于 view-at-event 精确恢复）。 */
  basisRefs: EntityRef[];
  /** 因果链：触发本事件的前一事件。 */
  causedBy: string | null;
  /** 反例情形标签（重放要真实经过这些情形）。 */
  scenarioTag?:
    | "phase_boundary"
    | "low_amplitude_hole"
    | "multiply_connected"
    | "cycle_misclosure"
    | "wavelength_version_change"
    | "integer_ambiguity"
    | "local_lock_conflict";
}

export interface Project {
  projectId: string;
  name: string;
  seed: number;
  createdAt: number;
  /** 事件顺序是身份/顺序保持的关键。 */
  events: LedgerEvent[];
}
