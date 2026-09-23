/**
 * 干涉条纹簿 —— 领域数据契约
 *
 * 设计原则：
 *  - 直接使用光学干涉/相位展开/标定领域词汇，不压成 name/value。
 *  - 输入实体（包裹相位、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史）
 *    一经提交不可覆盖；修订 = 新版本 + 父版本关系。
 *  - 一切引用都带 series_id + version；引用版本缺失即损坏，禁止回退最新版。
 *  - 所有领域量携带单位或坐标基准；导入时保留原始表示，派生层才规范化。
 */

export type Kind =
  | "wrapped_phase"
  | "snr_score"
  | "invalid_mask"
  | "wavelength"
  | "incidence_geometry"
  | "calibration_plane"
  | "cut_edit_history";

export type DerivedKind =
  | "normalized_inputs"
  | "quality_map"
  | "residue_map"
  | "cut_network"
  | "unwrap_tree"
  | "integer_offsets"
  | "unwrapped_phase"
  | "cycle_residuals"
  | "cycle_candidates"
  | "height_conversion"
  | "height_field";

export type EntityKind = Kind | DerivedKind;

/** 带原始单位/基准的标量。raw 是导入时的原样表示，永不改写。 */
export interface UnitScalar {
  raw: number | string;
  unit: string; // 例如 "rad" | "nm" | "deg" | "dimensionless" | 未知单位照原样保留
  basis?: string; // 坐标基准/参考说明
}

export interface GridBasis {
  rows: number;
  cols: number;
  /** 坐标基准：像素原点(0,0)的位置 + 像素间距引用 */
  origin: "top-left";
  pixel_pitch_ref?: EntityRef;
}

/** 包裹相位网格（原相位像素），单位 rad，值域 (-π, π]；以二维数组保留原始表示。 */
export interface WrappedPhaseContent {
  grid: number[][];
  unit: "rad";
  range: "(-pi, pi]";
  basis: GridBasis;
  /** 无法解释的原始值（如 "NaN"、"null"、越界值）留在原位置并附诊断，不丢弃。 */
  diagnostics: CellDiagnostic[];
}

/** 振幅/信噪评分。raw_amplitude 保留导入原值；snr 是派生层的归一化结果。 */
export interface SnrScoreContent {
  raw_amplitude: (number | string | null)[][];
  amplitude_unit: string;
  snr: (number | null)[][]; // 0..1，无效像素为 null
  normalization: "minmax" | "provided" | "none";
  basis: GridBasis;
  diagnostics: CellDiagnostic[];
}

export interface InvalidMaskContent {
  /** true = 无效（低振幅孔洞、坏点等）。遮罩本身不可覆盖。 */
  invalid: boolean[][];
  basis: GridBasis;
  reasons: Record<string, MaskReason>; // "r,c" -> 原因
}

export interface MaskReason {
  reason: "low_amplitude" | "saturated" | "bad_pixel" | "import_flag";
  detail?: string;
}

export interface WavelengthContent {
  value: UnitScalar; // 例如 {raw: 632.8, unit: "nm"}
  /** 规范化后的值（米）。单位无法转换时为 null 并附诊断。 */
  meters: number | null;
  diagnostics: ConversionDiagnostic[];
}

/** 入射几何：入射角/方位角 + 灵敏度方向 + 像素间距。 */
export interface IncidenceGeometryContent {
  incidence_angle: UnitScalar; // 相对法线
  azimuth: UnitScalar;
  sensitivity_factor: UnitScalar; // K，无量纲；高度 h = λ·φ / (2π·K)
  pixel_pitch: UnitScalar; // 米
  radians: { incidence_angle: number | null; pixel_pitch_m: number | null; k: number | null };
  diagnostics: ConversionDiagnostic[];
}

/** 标定面：平面方程 z = a*x + b*y + c（坐标基准 + 单位），并显式绑定波长版本。 */
export interface CalibrationPlaneContent {
  a: UnitScalar;
  b: UnitScalar;
  c: UnitScalar;
  coordinate_basis: string;
  /** 标定依据哪一版波长——波长改版后，旧高度结果只能代表旧标定。 */
  wavelength_ref: EntityRef;
  diagnostics: ConversionDiagnostic[];
}

/** 一条人工切口/撤销的不可变记录。 */
export interface CutEdit {
  edit_id: string;
  action: "add" | "remove";
  edge: GridEdge;
  reason: string;
}

export interface CutEditHistoryContent {
  edits: CutEdit[];
  /** 当前生效切口 = 顺序折叠 edits 得到，编辑历史本身只追加。 */
  active_cut_keys: string[];
}

export interface GridEdge {
  a: [number, number];
  b: [number, number];
}

export interface CellDiagnostic {
  at: [number, number];
  code:
    | "unparseable_number"
    | "out_of_wrapped_range"
    | "shape_mismatch"
    | "unknown_unit"
    | "missing_value";
  message: string;
  raw: unknown;
}

export interface ConversionDiagnostic {
  code: "unknown_unit" | "unconvertible" | "missing_reference";
  path: string;
  message: string;
  raw: unknown;
}

/** 实体引用：查询任一实体都返回这些；缺版本 = 损坏。 */
export interface EntityRef {
  kind: EntityKind;
  series_id: string;
  version: number;
  content_hash?: string;
  summary?: string;
}

export type EntityStatus =
  | "current" // 当前工作集选用
  | "superseded" // 已有更新版本/派生重算
  | "historical" // 历史视图
  | "blocked"; // 上游单位无法转换等，链路阻断

/** 输入实体版本（不可变）。 */
export interface InputEntity {
  kind: Kind;
  series_id: string;
  version: number;
  parent_version: number | null;
  content_hash: string;
  content: unknown;
  status: EntityStatus;
  origin: { source: "import" | "edit" | "case_pack"; import_name?: string; note?: string };
  created_event_seq: number;
}

/** 派生值：带算法版本、参数指纹、直接来源（全部版本化）。 */
export interface DerivedEntity {
  kind: DerivedKind;
  series_id: string;
  version: number;
  algorithm: { name: string; version: string };
  parameter_fingerprint: string;
  direct_sources: EntityRef[];
  content_hash: string;
  content: unknown;
  status: EntityStatus;
  created_event_seq: number;
}

export type AnyEntity = InputEntity | DerivedEntity;

// ---------- 派生内容 ----------

export interface QualityMapContent {
  /** 0..1 或 "unknown"（低振幅/无效像素不猜） */
  quality: (number | "unknown")[][];
  blocked: boolean[][];
  basis: GridBasis;
  sources: EntityRef[];
}

export interface ResidueMapContent {
  /** 每个 2x2 小环的电荷 +1/-1/0，坐标为小环左上角像素。 */
  charge: number[][]; // (rows-1) x (cols-1)
  wrap_sum: number[][];
  basis: GridBasis;
}

export type CutReason = "residue_pair" | "residue_to_border" | "manual" | "manual_removed";

export interface CutRecord {
  cut_id: string;
  edge: GridEdge;
  reasons: CutReason[];
  residue_refs?: string[]; // plaquette 稳定身份
}

export interface CutNetworkContent {
  cuts: CutRecord[];
  auto_cut_keys: string[];
  manual_cut_keys: string[];
  sources: EntityRef[];
}

export interface UnwrapTreeContent {
  /** 多连通区：每个连通分量一棵树。树边带整周增量。 */
  components: UnwrapComponent[];
  sources: EntityRef[];
}

export interface UnwrapComponent {
  component_id: string;
  seed: [number, number];
  /** 树边：parent -> child，k 为整周增量 φ_child = wrap + 2πk 基准 parent。 */
  edges: TreeEdge[];
  pixels: [number, number][];
  reference_offset: number; // 该分量整周基准（通常 0；跨分量关系未知）
}

export interface TreeEdge {
  edge_id: string;
  parent: [number, number];
  child: [number, number];
  k: number;
  wrap_delta: number;
}

export interface CycleResidual {
  residual_id: string;
  edge: GridEdge;
  residual_rad: number; // wrap(φb-φa) - (Φb-Φa)
  closed: boolean;
  tolerance_rad: number;
  in_tree: boolean;
}

export interface CycleResidualsContent {
  residuals: CycleResidual[];
  any_unclosed: boolean;
  sources: EntityRef[];
}

export interface IntegerOffsetsContent {
  /** 每像素整周数；低振幅/无效孔洞为 null（不猜）。 */
  k: (number | null)[][];
  unknown_cells: [number, number][];
  sources: EntityRef[];
}

export type CellStatus = "ok" | "unknown_low_amplitude" | "unknown_invalid" | "blocked_unit";

export interface UnwrappedPhaseContent {
  phase_rad: (number | null)[][];
  cell_status: CellStatus[][];
  components: string[][]; // component_id 或 "hole"
  sources: EntityRef[];
}

export interface CycleCandidate {
  candidate_id: string;
  /** 候选适用对象：切口边两侧 或 多连通分量之间 的整周关系。 */
  scope:
    | { type: "cut_edge"; edge: GridEdge }
    | { type: "component_gap"; components: [string, string]; via: GridEdge };
  k: number; // 整周偏移候选
  delta_rad: number;
  legal: boolean;
  reject_reasons?: string[];
  weight: number; // 平滑/质量支撑评分
  chosen?: boolean;
  chosen_by_event_seq?: number;
}

export interface CycleCandidatesContent {
  candidates: CycleCandidate[];
  /** 无法唯一决定：同一 scope 存在多个合法候选 */
  ambiguous_scopes: string[];
  sources: EntityRef[];
}

export interface HeightConversionContent {
  /** 高度转换链：逐环显式列出，波长换版会使本实体过期。 */
  steps: HeightChainStep[];
  wavelength_ref: EntityRef;
  geometry_ref: EntityRef;
  calibration_ref: EntityRef;
  unwrapped_ref: EntityRef;
  blocked: boolean;
  diagnostics: ConversionDiagnostic[];
  sources: EntityRef[];
}

export interface HeightChainStep {
  step_id: string;
  label: string;
  formula: string;
  inputs: { name: string; value: number | string; unit: string; ref?: EntityRef }[];
  output: { value: number | string; unit: string };
}

export interface HeightFieldContent {
  height_m: (number | null)[][];
  cell_status: CellStatus[][];
  residual_after_calibration_m: (number | null)[][];
  sources: EntityRef[];
}

// ---------- 锁定 / 人工决定 ----------

export type LockTargetType = "cut_edge_candidate" | "component_offset" | "cell";

export interface LocalLock {
  lock_id: string;
  target_type: LockTargetType;
  target_key: string;
  chosen_candidate_id?: string;
  note: string;
  active: boolean;
  set_event_seq: number;
  superseded_by_event_seq?: number;
}

// ---------- 事件（机器可读、只追加、哈希链） ----------

export type EventType =
  | "project_created"
  | "case_loaded"
  | "input_committed"
  | "parameter_revised"
  | "cut_edit_applied"
  | "computed"
  | "candidate_adjudicated"
  | "local_lock_set"
  | "local_lock_cleared"
  | "lock_conflict_detected"
  | "undo"
  | "view_pinned"
  | "exported"
  | "archive_imported";

export interface JournalEvent {
  seq: number;
  ts: string; // ISO，测试中由虚拟时钟给出
  type: EventType;
  actor: "human" | "system" | "case_pack";
  payload: Record<string, unknown>;
  /** 本事件判定所依据的领域规则（机器可读）。 */
  rationale_codes: string[];
  parent_hash: string | null;
  event_hash: string;
}

/** 反例情形标签。 */
export type ScenarioTag =
  | "phase_wrap_boundary"
  | "low_amplitude_hole"
  | "multiply_connected"
  | "cycle_nonclosure"
  | "wavelength_version_change"
  | "integer_cycle_ambiguity"
  | "local_lock_conflict";

/** 参数版本（算法参数也版本化，带指纹）。 */
export interface AlgorithmParameters {
  version: number;
  parent_version: number | null;
  low_amplitude_threshold: number; // snr 阈值，低于即孔洞，不猜
  cycle_closure_tolerance_rad: number;
  quality_seed_policy: "max_snr";
  max_candidate_k: number;
  smoothness_weight: number;
  fingerprint: string;
  note?: string;
}
