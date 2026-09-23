/**
 * 干涉条纹簿 领域数据契约
 *
 * 约定：
 * - 输入实体（raw inputs）一经提交即不可覆盖，修订以新版本 + 父版本关系表达。
 * - 派生实体（derived）携带算法版本、参数指纹与直接来源（版本级引用）。
 * - 所有领域量携带单位或坐标基准；rawRepresentation 保留导入时的原始表示。
 * - 无法转换的值保留在原位置并附诊断（conversionDiagnostics），不得为画图丢弃。
 */

export const ALGORITHM_VERSION = "phase-unwrap-1.0.0";

/** 固定种子与虚拟时间由调用方注入，使重放完全确定 */
export interface Clock {
  now(): string;
}

export interface ValueWithUnit<V = number> {
  value: V;
  unit: string;
  /** 导入时的原始表示（例如 "632.8 nm"、"12deg"），规范化只发生在派生层 */
  raw: string;
}

export interface CoordSystem {
  id: string;
  /** 行/列轴单位与零点定义，例如 top-left, pixel, x-right/y-down */
  origin: string;
  rowAxis: string;
  colAxis: string;
}

export interface Grid2D<T = number> {
  rows: number;
  cols: number;
  data: T[];
  coordSystem: string;
}

export type PhaseUnit = "radian:wrapped" | "radian" | "degree:wrapped";

/** 原相位像素（包裹相位帧） */
export interface WrappedPhaseFrame {
  kind: "wrapped_phase_frame";
  rows: number;
  cols: number;
  /** 每个原相位像素的包裹相位值，范围随 phaseUnit 而定（radian:wrapped → [-π,π)） */
  phaseRad: (number | null)[];
  phaseUnit: PhaseUnit;
  coordSystem: CoordSystem;
  /** 导入时逐像素的原始表示（字符串），与 phaseRad 对齐；null 表示该像素无效/缺失 */
  rawPixels: (string | null)[];
}

/** 振幅帧（低振幅 → 低信噪） */
export interface AmplitudeFrame {
  kind: "amplitude_frame";
  rows: number;
  cols: number;
  amplitude: (number | null)[];
  unit: string;
  coordSystem: CoordSystem;
  rawPixels: (string | null)[];
}

/** 信噪评分（质量图的输入之一，0..1；允许 null=未知） */
export interface QualityScores {
  kind: "quality_scores";
  rows: number;
  cols: number;
  score: (number | null)[];
  scale: "0..1";
  coordSystem: CoordSystem;
}

/** 无效遮罩：true=该像素无效（孔洞/遮拦），不得猜相位 */
export interface InvalidMask {
  kind: "invalid_mask";
  rows: number;
  cols: number;
  invalid: boolean[];
  coordSystem: CoordSystem;
}

/** 波长（版本化） */
export interface Wavelength {
  kind: "wavelength";
  lambda: ValueWithUnit;
}

/** 入射几何 */
export interface IlluminationGeometry {
  kind: "illumination_geometry";
  /** 入射角，0=法线方向 */
  incidence: ValueWithUnit;
  /** 方位角（可选，未知时 value=null 并附诊断） */
  azimuth: ValueWithUnit<number | null>;
  /** 敏感度方向单位向量（派生层由角度换算；无法转换时为 null） */
  sensitivityDirection: { x: number; y: number; z: number } | null;
}

/** 标定面（参考平面） */
export interface CalibrationPlane {
  kind: "calibration_plane";
  /** 平面 z = a*x + b*y + c，系数携带坐标基准与单位 */
  coefficients: { a: ValueWithUnit; b: ValueWithUnit; c: ValueWithUnit };
  residualRms: ValueWithUnit | null;
  coordSystem: CoordSystem;
}

/** 切口编辑历史（不可覆盖的编辑记录序列） */
export interface CutEdit {
  editId: string;
  action: "add_cut" | "remove_cut" | "force_connect";
  edgeId: string;
  endpoints: [number, number];
  reason: string;
  operator: string;
  at: string;
}
export interface CutEditHistory {
  kind: "cut_edit_history";
  edits: CutEdit[];
}

export type InputKind =
  | "wrapped_phase_frame"
  | "amplitude_frame"
  | "quality_scores"
  | "invalid_mask"
  | "wavelength"
  | "illumination_geometry"
  | "calibration_plane"
  | "cut_edit_history";

export type InputEntity =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | QualityScores
  | InvalidMask
  | Wavelength
  | IlluminationGeometry
  | CalibrationPlane
  | CutEditHistory;

/* ---------------- 派生实体 ---------------- */

/** 残差点电荷：+1 / -1（2π 缠绕的局部和） */
export interface Residue {
  pixel: number;
  charge: 1 | -1;
  wrapSum: number;
}
export interface ResidueMap {
  kind: "residue_map";
  rows: number;
  cols: number;
  residues: Residue[];
}

export interface BranchCut {
  edgeId: string;
  endpoints: [number, number];
  /** manual=来自切口编辑历史；dipole=算法连接正负残差 */
  source: "manual" | "dipole";
  editId?: string;
}
export interface BranchCutNetwork {
  kind: "branch_cut_network";
  cuts: BranchCut[];
  /** 未被任何切口中和的残差像素 */
  unbalancedResidues: number[];
}

/** 遮罩+切口诱导的连通区 */
export interface ConnectedRegion {
  regionId: string;
  pixels: number[];
  bounded: boolean;
}
export interface RegionMap {
  kind: "region_map";
  regions: ConnectedRegion[];
  invalidPixels: number[];
}

/** 展开树：区内的一棵生成树及其路径 */
export interface UnwrapTree {
  regionId: string;
  root: number;
  /** node -> 父节点（根为 -1） */
  parent: number[];
  /** node 到父节点的包裹梯度（含整周） */
  parentWrappedDelta: number[];
  /** 边的权重来源（质量积），用于解释为何选这条路径 */
  edgeWeight: number[];
}

/** 循环残差：沿闭合回路边的缠绕梯度之和（弧度），0=闭合 */
export interface CycleResidual {
  cycleId: string;
  edges: string[];
  pixels: number[];
  residualRad: number;
  /** 最接近的 2π 整数倍（应当为 0；非零说明循环不闭合） */
  nearest2PiMultiple: number;
  closes: boolean;
  reason: string;
}

/** 整周候选：相邻像素（尤其切口两侧）之间的整周偏移候选 */
export interface IntegerCandidate {
  candidateId: string;
  edgeId: string;
  endpoints: [number, number];
  /** 合法的整数 k 列表（通常 1 个；切口两侧/多连通可多个） */
  kValues: number[];
  /** 被拒绝的候选及原因（一等数据） */
  rejected: { k: number; reason: string }[];
  ambiguity: "unique" | "multiple";
  /** 不确定性/误差估计（rad），null=未知 */
  uncertaintyRad: number | null;
  note: string;
}

export interface UnwrappedPhase {
  kind: "unwrapped_phase";
  rows: number;
  cols: number;
  /** 展开相位 rad；孔洞/未决定区域为 null（绝不猜） */
  phaseRad: (number | null)[];
  /** 每个像素相对参考像素的整周数 n，φ_unwrap = φ_wrap + 2πn；未知为 null */
  integerCycles: (number | null)[];
  referencePixel: number;
  trees: UnwrapTree[];
}

/** 高度转换：φ → 物理高度 */
export interface HeightField {
  kind: "height_field";
  rows: number;
  cols: number;
  /** 物理高度；无法转换（波长/几何失效）时为 null */
  z: (number | null)[];
  unit: string;
  coordSystem: string;
  /** 每像素转换状态：ok / unknown_low_amplitude / wavelength_unresolved / geometry_unresolved / masked */
  status: HeightPixelStatus[];
  sensitivityFactor: number | null;
}
export type HeightPixelStatus =
  | "ok"
  | "unknown_low_amplitude"
  | "wavelength_unresolved"
  | "geometry_unresolved"
  | "masked";

/** 局部锁定：审阅者锁定某个像素/区域/边的局部解读 */
export interface RegionLock {
  lockId: string;
  scope: "pixel" | "edge" | "region";
  targetId: string;
  claim:
    | { type: "integer_cycle"; pixel: number; k: number }
    | { type: "edge_offset"; edgeId: string; k: number }
    | { type: "region_constant"; regionId: string; offset: number };
  rationale: string;
  lockedAt: string;
  /** undo 时置位，但记录保留 */
  undone: boolean;
  undoneAt: string | null;
  decisionEventId: string;
}

/** 裁定结果 */
export type Verdict = "accepted" | "rejected" | "adjusted";

export type DerivedKind =
  | "residue_map"
  | "branch_cut_network"
  | "region_map"
  | "cycle_residual_set"
  | "candidate_set"
  | "unwrapped_phase"
  | "height_field";

export type EntityKind = InputKind | DerivedKind | "lock";

/* ---------------- 版本与引用 ---------------- */

export type ContentStatus = "valid" | "with_diagnostics";

export interface ConversionDiagnostic {
  path: string;
  code:
    | "UNIT_UNRESOLVED"
    | "VALUE_UNPARSEABLE"
    | "OUT_OF_RANGE"
    | "GRID_SHAPE_MISMATCH"
    | "MISSING_FIELD";
  message: string;
  /** 无法转换时保留在原位置的原始值 */
  rawValue?: string;
}

export interface EntityVersion {
  id: string; // ver_... 稳定身份
  projectId: string;
  kind: InputKind;
  entityId: string; // 同一逻辑实体跨版本共享
  versionNo: number;
  parentVersionId: string | null;
  content: InputEntity;
  rawRepresentation: unknown;
  status: ContentStatus;
  diagnostics: ConversionDiagnostic[];
  /** 内容指纹：canonical JSON 的 sha256，导入/导出后保持 */
  contentHash: string;
  algorithmVersion: null;
  paramFingerprint: null;
  sources: null;
  createdAt: string;
  createdBy: string;
  revisionReason: string | null;
}

export interface DerivedRecord {
  id: string; // der_...
  projectId: string;
  kind: DerivedKind;
  /** 同一逻辑派生实体的稳定 id（例如某次 run 内的 unwrapped_phase#1） */
  entityId: string;
  /** 计算 run：同一 run 产出 residue/cut/region/cycle/candidate/unwrap/height 一组 */
  runId: string;
  content: unknown;
  algorithmVersion: string;
  paramFingerprint: string;
  /** 直接来源：版本级 / 派生记录级引用，缺少引用即损坏，不允许退回最新版 */
  sources: SourceRef[];
  contentHash: string;
  createdAt: string;
  /** current=基于当前来源；stale=某个直接来源已被新版本取代，仍可查看但不能冒充当前 */
  freshness: "current" | "stale";
  supersededByRunId: string | null;
}

export type SourceRef =
  | { refType: "input"; kind: InputKind; entityId: string; versionId: string }
  | { refType: "derived"; kind: DerivedKind; entityId: string; recordId: string };

/* ---------------- 事件（机器可读判断依据） ---------------- */

export type PrincipleCode =
  | "NO_GUESS_LOW_AMPLITUDE"
  | "EXPLICIT_INTEGER_OFFSET_ACROSS_CUTS"
  | "TREE_LOCAL_CONSISTENCY_WITH_CYCLE_RESIDUALS"
  | "HISTORY_NOT_OVERWRITTEN";

export type EventType =
  | "project_created"
  | "input_submitted"
  | "input_rejected"
  | "revision_submitted"
  | "pipeline_run"
  | "candidate_decided"
  | "region_locked"
  | "lock_conflict"
  | "lock_undone"
  | "verdict_recorded"
  | "scenario_triggered"
  | "bundle_imported"
  | "bundle_exported";

export interface PrincipleEvidence {
  principle: PrincipleCode;
  holds: boolean;
  detail: string;
  /** 涉及的稳定身份 */
  targets: string[];
}

export interface DomainEvent {
  id: string; // evt_...
  projectId: string;
  seq: number;
  type: EventType;
  at: string;
  operator: string;
  payload: Record<string, unknown>;
  /** 本事件所依据的判断原则（机器可读），无则空数组 */
  principles: PrincipleEvidence[];
  /** 本事件作出时引用的全部版本/记录快照（回到旧事件时恢复依赖版本与可见结论） */
  refs: SourceRef[];
  /** 与父事件的因果关系（撤销链、决定链） */
  causedBy: string | null;
}
