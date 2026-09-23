// 干涉条纹簿：相位展开、支路切口与光学标定分支
// 数据契约直接使用光学干涉领域词汇，禁止压成 name/value。
//
// 身份稳定性：所有实体/事件拥有稳定 ID；同一逻辑实体的修订用
// (id, version, parent_version) 表达，旧版本永不被覆盖。

export type UnitKind =
  | "radian_wrapped" // 包裹相位 (-pi, pi]
  | "dimensionless"
  | "boolean_cell"
  | "nanometer"
  | "micrometer"
  | "millimeter"
  | "meter"
  | "degrees"
  | "incidence_sine" // sin(theta)
  | "fringe_order";

export interface CoordBasis {
  origin: [number, number]; // 像素坐标原点（0 基），导入原始表示
  xStep: NumberToken; // 横向采样间隔（带单位）
  yStep: NumberToken; // 纵向采样间隔（带单位）
  axisLabel: "pixel" | "mm" | "um";
}

export interface NumberToken {
  // 导入时保留的原始表示；派生层才规范化。
  raw: string;
  value: number | null; // 无法转换时为 null，诊断写入 diagnostics
  unit: string;
}

export interface CellDiagnostic {
  index: number; // 扁平像素下标
  code:
    | "UNPARSEABLE_NUMBER"
    | "OUT_OF_WRAP_RANGE"
    | "UNKNOWN_UNIT"
    | "NEGATIVE_WAVELENGTH"
    | "MISSING_CELL";
  message: string;
}

// ---------- 原始栅格：原相位像素 / 信噪评分 / 无效遮罩 ----------

export interface RawGrid {
  width: number;
  height: number;
  // 每个单元格保存原始字符串与（可转则）数值；无法转换留在原位。
  cells: NumberToken[]; // length === width*height
  diagnostics: CellDiagnostic[];
}

export type InputContentKind =
  | "wrapped_phase"
  | "signal_noise"
  | "invalid_mask"
  | "wavelength"
  | "illumination_geometry"
  | "calibration_surface"
  | "cut_edit_history";

export type DerivedContentKind =
  | "residue_map"
  | "quality_map"
  | "branch_cut_network"
  | "unwrap_tree"
  | "integer_candidates"
  | "height_conversion";

export type ReviewContentKind = "lock_decision";

export type ContentKind =
  | InputContentKind
  | DerivedContentKind
  | ReviewContentKind;

// ---------- 输入实体内容（一经提交不可覆盖，修订即新版本） ----------

export interface WrappedPhaseContent {
  kind: "wrapped_phase";
  phase: RawGrid;
  coordBasis: CoordBasis;
}

export interface SignalNoiseContent {
  kind: "signal_noise";
  amplitude: RawGrid; // 振幅（导入实体之一）
  snr: RawGrid; // 由振幅等计算的信噪评分（保留原始表示+归一化）
}

export interface InvalidMaskContent {
  kind: "invalid_mask";
  mask: RawGrid; // boolean_cell；1=无效/低振幅孔洞
  lowAmplitudeThreshold: NumberToken;
}

export interface WavelengthContent {
  kind: "wavelength";
  lambda: NumberToken;
  normalizedMeters: number | null;
  versionTag: string; // 波长版本（如 lambda-A / lambda-B）
}

export interface IlluminationGeometryContent {
  kind: "illumination_geometry";
  incidence: NumberToken; // 入射角（度）
  sine: number | null; // sin(theta)，无法转换留诊断
  observation: "normal" | "same_side" | "opposite_side";
  sensitivityFactor: number | null; // 1+cos(theta) 等（取决于配置）
}

export interface CalibrationSurfaceContent {
  kind: "calibration_surface";
  plane: RawGrid; // 标定面（拟合平面残差，带坐标基准）
  coordBasis: CoordBasis;
  fit: { intercept: NumberToken; slopeX: NumberToken; slopeY: NumberToken };
}

export interface CutEditEvent {
  // 切口编辑历史：append-only。每条记录是一次不可变编辑。
  seq: number;
  atClock: string;
  operator: string;
  action: "place_cut" | "remove_cut" | "place_zero_curl" | "reroute";
  edge: EdgeRef;
  reason: string;
}

export interface CutEditHistoryContent {
  kind: "cut_edit_history";
  events: CutEditEvent[];
}

// ---------- 领域几何 ----------

export interface PixelRef {
  x: number;
  y: number;
}

export interface EdgeRef {
  // 二维四邻域切口边
  a: PixelRef;
  b: PixelRef;
}

export type ResidueCharge = 1 | -1 | 0;

export interface ResidueMapContent {
  kind: "residue_map";
  width: number;
  height: number;
  charges: ResidueCharge[]; // 每 2x2 单元一个电荷（width-1)*(height-1)
  positiveCount: number;
  negativeCount: number;
}

export interface QualityMapContent {
  kind: "quality_map";
  width: number;
  height: number;
  score: number[]; // 质量分 0..1；无效/低振幅孔洞 = 0 且 unknown=true
  unknown: boolean[]; // true 表示不猜、不可参与展开
  snrWeight: number[];
  residuePenalty: number[];
}

export interface BranchCutNetworkContent {
  kind: "branch_cut_network";
  width: number;
  height: number;
  cuts: { edge: EdgeRef; residueLinked: boolean; mandatory: boolean }[];
  // mandatory=true 表示切口两侧整周偏移必须显式表示，禁止跨边积分
  unpairedResidues: PixelRef[];
}

// ---------- 展开树 / 整周候选 / 高度 ----------

export interface TreeEdge {
  parent: PixelRef;
  child: PixelRef;
  wrappedDelta: number; // wrap(phi_child - phi_parent)
  k: number; // 整周（fringe order）
  cutCrossing: boolean;
}

export interface LoopResidual {
  pixels: PixelRef[]; // 闭合环路
  sumWrapped: number; // 环绕包裹差之和
  residualCycles: number; // 非零即循环不闭合
  closes: boolean;
  crossesCut: boolean;
}

export interface UnwrapTreeContent {
  kind: "unwrap_tree";
  root: PixelRef;
  width: number;
  height: number;
  connectedComponents: PixelRef[][]; // 多连通区（孔洞/遮罩切分）
  edges: TreeEdge[];
  unwrapped: (number | null)[]; // 低振幅孔洞处为 null（不猜相位）
  loops: LoopResidual[];
  maxLoopResidualCycles: number;
  fractional: number[]; // 相对根的非整周相位（rad），便于换波长复核
}

export interface IntegerCandidate {
  pixel: PixelRef;
  candidates: number[]; // 全部合法整周 k（多解时保留全部）
  rejected: { k: number; reason: string }[]; // 拒绝原因是一等数据
  chosen: number | null;
  ambiguous: boolean;
}

export interface IntegerCandidatesContent {
  kind: "integer_candidates";
  perPixel: IntegerCandidate[];
  ambiguityReason: string | null;
}

export interface HeightCell {
  pixel: PixelRef;
  unwrappedRad: number | null; // 未知为 null
  heightMeters: number | null; // 未知/未换算为 null
  unknown: boolean;
  unknownReason: string | null;
}

export interface HeightConversionContent {
  kind: "height_conversion";
  factorMetersPerRadian: number | null;
  wavelengthVersion: string;
  geometrySummary: string;
  cells: HeightCell[];
  calibrationApplied: boolean;
}

// ---------- 复核：局部锁定 ----------

export interface LockDecisionContent {
  kind: "lock_decision";
  target: PixelRef;
  lockedK: number | null; // 锁定的整周
  lockedHeightMeters: number | null;
  verdict: "accepted" | "rejected" | "parameter_adjusted" | "conflict";
  rationale: string;
  conflictsWith: EntityId[]; // 与其他锁定/候选冲突
  supersedesLock: EntityId | null;
}

// ---------- 实体信封与溯源 ----------

// 品牌化 ID（编译期防止把普通字符串当身份）
declare const brand: unique symbol;
export type EntityId = string & { readonly [brand]: "EntityId" };
export type EventId = string & { readonly [brand]: "EventId" };
export type ProjectId = string & { readonly [brand]: "ProjectId" };

export interface SourceRef {
  entityId: EntityId;
  version: number; // 必须显式引用版本，禁止隐式最新
  contentHash: string;
  role: string; // 该来源在计算中的作用
}

export interface EntityEnvelope<TContent = unknown> {
  id: EntityId;
  version: number;
  parentVersion: number | null;
  projectId: ProjectId;
  kind: ContentKind;
  displayName: string; // 领域名称（如“包裹相位 #3”），非通用 name/value
  status:
    | "current"
    | "superseded"
    | "stale_view" // 输入修订后派生结果过期，仍可查看不可冒充当前
    | "damaged";
  algorithmVersion: string | null;
  parameterFingerprint: string | null;
  sources: SourceRef[];
  contentHash: string;
  createdAtClock: string;
  content: TContent;
}

// ---------- 事件（机器可读取的判断依据） ----------

export type EventType =
  | "project_created"
  | "input_committed"
  | "input_revised"
  | "derivative_computed"
  | "stale_marked"
  | "adjudication"
  | "lock_set"
  | "lock_conflict"
  | "lock_released"
  | "cut_edited"
  | "exported"
  | "imported"
  | "corruption_detected"
  // 反例档案专用判断事件
  | "counterexample_baseline"
  | "counterexample_perturbation"
  | "candidate_adopted"
  | "candidate_rejected";

export interface EventEnvelope {
  id: EventId;
  seq: number;
  projectId: ProjectId;
  atClock: string;
  type: EventType;
  message: string;
  subjectEntityId: EntityId | null;
  subjectVersion: number | null;
  sources: SourceRef[];
  payload: Record<string, unknown>;
}
