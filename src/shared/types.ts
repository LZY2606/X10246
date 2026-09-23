/*
 * 干涉条纹簿：相位展开、支路切口与光学标定分支
 * 领域数据契约 —— 直接使用光学/相位展开词汇，禁止压成 name/value。
 */

/** 稳定标识：内容用内容哈希；版本/事件用 项目前缀 + 单调序号；区域/候选用确定性派生 id。 */
export type ContentId = string; // sha256 十六进制
export type ObjectId = string; // obj_<kind>_<short>
export type EventId = string; // evt_000001
export type RegionId = string; // region_<x>_<y> 或 region_<bbox hash>
export type CandidateId = string; // cand_<region>_k<n>

/** 单位或坐标基准。所有领域量必须携带；无法转换的值留在原位并附诊断。 */
export interface UnitBasis {
  unit: string; // "radian_wrapped" | "radian" | "nm" | "um" | "degree" | "count" | "a.u." | "dimensionless" | "dB"
  coordinateBasis?: "pixel_index" | "calibrated_xy" | "fringe_order";
  reference?: string; // 基准说明，例如 "calibration_plane v#3 @ anchor A"
}

export interface Quant {
  value: number;
  unit: UnitBasis;
}

/** 网格数据：行优先小矩阵，保留原始表示。 */
export interface GridData {
  width: number;
  height: number;
  /** 规范化后的值（派生层才规范化）；未知用 null。 */
  values: (number | null)[];
  normalizedFrom?: string; // 规范化规则 id，例如 "uint8_to_rad_0_2pi"
}

export interface RawRepresentation {
  encoding: string; // "float64_rad" | "uint8_0_2pi" | "uint16_count" | "bool" ...
  values: (number | null | boolean)[];
  note?: string;
}

export interface ImportDiagnostic {
  code:
    | "UNCONVERTIBLE_VALUE_LEFT_IN_PLACE"
    | "MISSING_UNIT"
    | "UNKNOWN_GEOMETRY"
    | "RAW_ENCODING_UNSUPPORTED";
  at?: { x: number; y: number };
  message: string;
  rawValue?: unknown;
}

/* ---------------- 输入实体（原始内容一经提交不可覆盖） ---------------- */

export type InputKind =
  | "wrapped_phase"
  | "amplitude"
  | "snr_score"
  | "invalid_mask"
  | "wavelength"
  | "incidence_geometry"
  | "calibration_plane"
  | "cut_edit_history";

export interface WrappedPhasePayload {
  frame: GridData;
  raw: RawRepresentation;
  wrapRange: "[-pi,pi)" | "[0,2pi)";
  channel?: string;
}

export interface AmplitudePayload {
  frame: GridData;
  raw: RawRepresentation;
  amplitudeUnit: string;
}

export interface SnrScorePayload {
  frame: GridData;
  raw: RawRepresentation;
  scoreUnit: "dimensionless" | "dB";
  threshold?: number;
}

export interface InvalidMaskPayload {
  frame: { width: number; height: number; values: boolean[] };
  reason: string; // 例如 "saturated" | "imported_invalid"
}

export interface WavelengthPayload {
  wavelength: Quant; // value + nm/um
  channel: string;
  effectiveWavelength?: Quant; // 多波长合成时的等效波长
}

export interface IncidenceGeometryPayload {
  arrangement: "out_of_plane_normal_incidence" | "oblique_incidence" | "two_beam_holography";
  incidenceAngle?: Quant; // degree
  /** 灵敏度系数：高度 = 相位 * S；法向入射单/双程在导入规则中计算 */
  passFactor: number; // 1.0 单程 / 2.0 双程
  sensitivityVectorNote: string;
}

export interface CalibrationPlanePayload {
  /** 标定面锚点：像素 -> 物理坐标 */
  anchors: { x: number; y: number; physical: { x: Quant; y: Quant; z: Quant } }[];
  planeFit?: { normal: [number, number, number]; offset: number; residualRms: number };
  lengthUnit: string;
}

export interface CutEdit {
  editId: string;
  action: "add_cut" | "remove_cut";
  from: { x: number; y: number };
  to: { x: number; y: number };
  reason: string;
  /** 切口两侧的整周偏移必须显式表示（n = n_right - n_left）；未知给 null 并附诊断 */
  integerOffset: number | null;
}

export interface CutEditHistoryPayload {
  edits: CutEdit[];
  note: string;
}

export type InputPayload =
  | WrappedPhasePayload
  | AmplitudePayload
  | SnrScorePayload
  | InvalidMaskPayload
  | WavelengthPayload
  | IncidenceGeometryPayload
  | CalibrationPlanePayload
  | CutEditHistoryPayload;

/* ---------------- 判定/派生实体 ---------------- */

export type DerivedKind =
  | "residue_map"
  | "branch_cut_network"
  | "unwrapped_phase"
  | "unwrapped_tree"
  | "cycle_residuals"
  | "height_field"
  | "candidate_set"
  | "quality_map";

export type ObjectKind = InputKind | DerivedKind;

/** 残差点（2x2 环绕积分 / 2pi 的取整结果，应为 0；+1/-1 为电荷） */
export interface ResidueCharge {
  x: number;
  y: number; // 2x2 单元左上角
  charge: 1 | -1 | 0;
  wrapIntegral: number; // 环绕积分（rad）
}

export interface ResidueMapPayload {
  charges: ResidueCharge[];
  unknownCells: { x: number; y: number; reason: "low_amplitude" | "invalid_mask" | "phase_unknown" }[];
  algorithmVersion: string;
}

/** 支路切口网络：边上的整周偏移显式表示 */
export interface CutEdge {
  edgeId: string;
  a: { x: number; y: number };
  b: { x: number; y: number };
  integerOffset: number | null; // 显式整周偏移；null=不可判定（附诊断，禁止猜）
  source: "residue_pairing" | "imported_history" | "human_edit";
  pairing?: { plus: { x: number; y: number }; minus: { x: number; y: number } };
  diagnostic?: string;
}

export interface BranchCutNetworkPayload {
  edges: CutEdge[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

export interface QualityCell {
  x: number;
  y: number;
  score: number; // 0..1，越大越可靠
  reasons: ("amplitude" | "snr" | "distance_to_residue" | "mask")[];
}

export interface QualityMapPayload {
  cells: QualityCell[];
  width: number;
  height: number;
  algorithmVersion: string;
}

/** 展开树：局部一致解；保留路径与循环残差 */
export interface TreePathStep {
  from: { x: number; y: number };
  to: { x: number; y: number };
  wrappedDelta: number;
  integerJump: number; // 跨越 2pi 边界时加的整周
  crossesCut: boolean;
  cutEdgeId?: string;
}

export interface UnwrappedTreePayload {
  treeId: string;
  root: { x: number; y: number };
  paths: TreePathStep[];
  /** 该树连通分量覆盖的像素 */
  covered: { x: number; y: number }[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

export interface CycleResidual {
  cycleId: string;
  pixels: { x: number; y: number }[];
  residualTurns: number | null; // 环绕残差（整周）；null=含未知像素不可闭合
  closureState: "closed" | "open_unknown_pixel" | "open_cut_offset_missing" | "nonzero_residual";
  relatedCutEdgeIds: string[];
}

export interface CycleResidualsPayload {
  cycles: CycleResidual[];
  algorithmVersion: string;
}

export interface UnwrappedPixel {
  x: number;
  y: number;
  unwrappedRad: number | null; // null = 低振幅/遮罩，禁止猜
  unknownReason?: "low_amplitude" | "invalid_mask" | "isolated_component";
  treeId?: string;
  integerOrder: number | null;
}

export interface UnwrappedPhasePayload {
  width: number;
  height: number;
  pixels: UnwrappedPixel[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

export interface HeightPixel {
  x: number;
  y: number;
  height: number | null; // nm/um...
  conversionTrace: {
    unwrappedRadRef: CandidateId;
    sensitivityFactor: number; // h = phi * S
    wavelengthVersion: ObjectId;
    wavelengthVersionNo: number;
    geometryVersion: ObjectId;
    geometryVersionNo: number;
    calibrationVersion?: ObjectId;
    calibrationVersionNo?: number;
  } | null;
  unknownReason?: string;
}

export interface HeightFieldPayload {
  width: number;
  height: number;
  unit: string;
  pixels: HeightPixel[];
  conversionFormula: string;
  algorithmVersion: string;
}

/** 整周多解：无法唯一决定时保留全部合法候选 */
export interface IntegerCandidate {
  candidateId: CandidateId;
  region: { x: number; y: number }[];
  integerOffset: number;
  status: "legal" | "adopted" | "rejected";
  rejectReason?: string;
  consistencyEvidence: string;
  treeId: string;
}

export interface CandidateSetPayload {
  ambiguityId: string;
  scenario: ScenarioId;
  candidates: IntegerCandidate[];
  resolution: "unique" | "ambiguous" | "unresolvable";
}

export type DerivedPayload =
  | ResidueMapPayload
  | BranchCutNetworkPayload
  | QualityMapPayload
  | UnwrappedTreePayload
  | CycleResidualsPayload
  | UnwrappedPhasePayload
  | HeightFieldPayload
  | CandidateSetPayload;

/* ---------------- 七种反例情形 ---------------- */

export type ScenarioId =
  | "phase_boundary"
  | "low_amplitude_hole"
  | "multicomponent"
  | "cycle_nonclosure"
  | "wavelength_version"
  | "integer_ambiguity"
  | "lock_conflict";

/* ---------------- 引用 / 版本 / 事件 ---------------- */

export interface VersionRef {
  objectId: ObjectId;
  version: number;
}

export interface ContentRef {
  contentId: ContentId;
}

export type SourceRef = VersionRef | (ContentRef & { objectId?: ObjectId });

/** 内容记录：去重后只存一份不可变内容 */
export interface ContentRecord {
  contentId: ContentId;
  kind: ObjectKind;
  payload: unknown;
  raw?: unknown;
  diagnostics: ImportDiagnostic[];
  createdAt: string;
}

export type ObjectStatus =
  | "current"
  | "superseded"
  | "stale" // 局部源变化后过期；仍可查看，不能冒充当前
  | "rejected";

export interface ObjectVersionRecord {
  objectId: ObjectId;
  kind: ObjectKind;
  version: number;
  contentId: ContentId;
  parentVersionId?: EventId; // 父版本关系
  algorithmVersion?: string;
  parameterFingerprint?: string;
  sources: VersionRef[]; // 直接来源；缺少引用必须报损坏
  scopeRegions: RegionId[];
  status: ObjectStatus;
  createdAt: string;
  createdByEvent: EventId;
  summary: string; // 内容摘要
}

export interface QueryResult {
  objectId: ObjectId;
  version: number;
  kind: ObjectKind;
  status: ObjectStatus;
  summary: string;
  sources: VersionRef[];
  payload: unknown;
}

/* ---------------- 机器可读取事件 ---------------- */

export type EventType =
  | "input_committed"
  | "parameter_revision"
  | "source_data_revision"
  | "computation_completed"
  | "candidate_adopted"
  | "candidate_rejected"
  | "local_lock"
  | "local_unlock"
  | "lock_conflict_detected"
  | "cut_edit_applied"
  | "wavelength_switched"
  | "undo"
  | "redo"
  | "import_bundle"
  | "export_bundle";

export interface LedgerEvent {
  eventId: EventId;
  seq: number;
  at: string;
  actor: string;
  type: EventType;
  scenario?: ScenarioId;
  objectId?: ObjectId;
  version?: number;
  parentEventId?: EventId;
  sources?: VersionRef[];
  payload?: unknown;
  /** 该事件采纳的判断依据（机器可读） */
  rationale?: JudgmentBasis;
  undone?: boolean;
}

/** “低振幅不猜、切口偏移显式、多树局部一致”的判断依据 */
export interface JudgmentBasis {
  rule:
    | "NO_GUESS_LOW_AMPLITUDE"
    | "EXPLICIT_CUT_INTEGER_OFFSET"
    | "TREE_LOCAL_CONSISTENCY_WITH_CYCLE_RESIDUAL"
    | "KEEP_ALL_LEGAL_INTEGER_CANDIDATES"
    | "LOCAL_SOURCE_CHANGE_SCOPED_STALENESS"
    | "MISSING_REF_IS_CORRUPT"
    | "LOCK_CONFLICT_REQUIRES_RESOLUTION";
  evidence: Record<string, unknown>;
  accepted: boolean;
}

/* ---------------- 项目与导出包 ---------------- */

export interface ProjectMeta {
  projectId: string;
  name: string;
  createdAt: string;
  clock: "virtual";
}

export interface ExportBundle {
  format: "interferometry-ledger/bundle";
  formatVersion: 1;
  project: ProjectMeta;
  contents: ContentRecord[]; // 去重内容
  versions: ObjectVersionRecord[];
  events: LedgerEvent[];
  casePackId?: string;
}

export interface CorruptionReport {
  code: "MISSING_REFERENCE" | "MISSING_CONTENT" | "DANGLING_VERSION" | "SEQUENCE_GAP" | "CONTENT_HASH_MISMATCH";
  ref?: VersionRef;
  message: string;
}
