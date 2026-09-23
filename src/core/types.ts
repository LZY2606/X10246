/**
 * 干涉条纹簿 —— 领域词汇类型层。
 * 绝不把领域量压成 name/value：每个实体有自己的字段、单位与坐标基准。
 *
 * 身份策略：
 *  - 内容对象使用内容寻址 ID（同内容 => 同 ID，导出/删除/再导入保持）；
 *  - 事件使用项目内顺序号 ID（顺序即历史）；
 *  - 一切引用显式携带 {id, kind, version}，缺失引用 => 损坏（不回退最新版）。
 */

export type Kind =
  | "raw_cell"
  | "wrapped_phase_frame"
  | "amplitude_frame"
  | "snr_frame"
  | "invalid_mask_frame"
  | "wavelength"
  | "incidence_geometry"
  | "calibration_surface"
  | "unwrap_params"
  | "unwrap_run"
  | "residue"
  | "cut_edge"
  | "cycle_residual"
  | "unwrap_value"
  | "candidate"
  | "height_value"
  | "cut_edit"
  | "decision"
  | "lock"
  | "conflict"
  | "snapshot";

export type Ref<TKind extends Kind = Kind> = {
  kind: TKind;
  id: string;
  /** 对象自身版本（输入角色版本或算法结果版本）。 */
  version: number;
};

export type Diagnostic = {
  code: string;
  severity: "error" | "warning";
  message: string;
  coordinate?: GridCoord;
};

export type GridCoord = { c: number; r: number };

export type UnitQuantity = {
  raw: string;
  value: number | null;
  unit: string | null;
  canonicalValue: number | null;
  canonicalUnit: string | null;
  diagnostics: Diagnostic[];
};

// ---------------------------------------------------------------------------
// 输入实体（一经提交不可覆盖；修订 = 新版本 + parentVersion）
// ---------------------------------------------------------------------------

/** 原相位像素：逐像素原始表示 + 规范化值；无法转换的值留在原位并附诊断。 */
export type RawCell = {
  kind: "raw_cell";
  id: string;
  version: 1;
  role: "phase" | "amplitude" | "snr" | "mask";
  coord: GridCoord;
  /** 实验室导入时的原始表示（字符串），永不规范化掉。 */
  raw: string;
  /** 派生层规范化结果；无法转换时为 null，诊断保留在原像素位置。 */
  numeric: number | null;
  unit: string | null;
  diagnostics: Diagnostic[];
};

export type FrameRefList = {
  grid: { cols: number; rows: number };
  /** 按 r*cols+c 排列的像素内容引用（顺序是一等数据）。 */
  cells: Ref<"raw_cell">[];
  missing: GridCoord[];
};

export type WrappedPhaseFrame = {
  kind: "wrapped_phase_frame";
  id: string;
  version: number;
  parentVersion: number | null;
  phaseUnit: "rad" | "turn";
  phaseRange: [number, number];
  roleVersion: number;
  frame: FrameRefList;
  diagnostics: Diagnostic[];
};

export type AmplitudeFrame = {
  kind: "amplitude_frame";
  id: string;
  version: number;
  parentVersion: number | null;
  rawUnit: string;
  roleVersion: number;
  /** 低振幅判定阈值（归一化后），属于解释参数但帧版本承载来源。 */
  frame: FrameRefList;
  diagnostics: Diagnostic[];
};

export type SnrFrame = {
  kind: "snr_frame";
  id: string;
  version: number;
  parentVersion: number | null;
  roleVersion: number;
  frame: FrameRefList;
  diagnostics: Diagnostic[];
};

export type InvalidMaskFrame = {
  kind: "invalid_mask_frame";
  id: string;
  version: number;
  parentVersion: number | null;
  roleVersion: number;
  /** true = 无效像素（实验室遮罩原样保留）。 */
  frame: FrameRefList;
  diagnostics: Diagnostic[];
};

/** 波长：带单位的物理量；版本变更必须使依赖高度结果过期。 */
export type Wavelength = {
  kind: "wavelength";
  id: string;
  version: number;
  parentVersion: number | null;
  quantity: UnitQuantity;
  label?: string;
};

/** 入射几何：入射角/相机角与像素节距，全部带基准。 */
export type IncidenceGeometry = {
  kind: "incidence_geometry";
  id: string;
  version: number;
  parentVersion: number | null;
  /** 入射光与表面法线夹角。 */
  incidenceAngle: UnitQuantity;
  /** 观察方向与表面法线夹角。 */
  observationAngle: UnitQuantity;
  /** 像素节距，如 "0.005 mm/pix"。 */
  pixelPitch: UnitQuantity;
  sensitivityFactor: number | null;
};

/** 标定面：平面/多项式参考面，携带坐标基准与系数单位。 */
export type CalibrationSurface = {
  kind: "calibration_surface";
  id: string;
  version: number;
  parentVersion: number | null;
  basis: "pixel_index";
  model:
    | { type: "plane"; a: UnitQuantity; b: UnitQuantity; d: UnitQuantity }
    | { type: "diagnostic_only"; reason: string };
  diagnostics: Diagnostic[];
};

/** 切口编辑历史：追加式，撤销也是新条目，永不覆盖。 */
export type CutEdit = {
  kind: "cut_edit";
  id: string; // evt_seq => 跨导出稳定
  version: 1;
  eventSeq: number;
  action: "add" | "remove";
  reason: "analyst" | "undo";
  edge: [GridCoord, GridCoord];
  /** 撤销时指向被撤销的编辑事件。 */
  undoesEventSeq: number | null;
  operator: string;
};

// ---------------------------------------------------------------------------
// 解释参数与派生实体
// ---------------------------------------------------------------------------

export type UnwrapParams = {
  kind: "unwrap_params";
  id: string;
  version: number;
  parentVersion: number | null;
  algVersion: string;
  amplitudeThreshold: number;
  snrThreshold: number;
  maxCandidates: number;
  /** 参数指纹：派生值必携带，参数修订 => 依赖过期。 */
  fingerprint: string;
};

export type Residue = {
  kind: "residue";
  id: string;
  version: 1;
  runId: string;
  /** 2x2 plaquette 左上角坐标。 */
  plaquette: GridCoord;
  charge: 1 | -1 | 0;
  /** 环绕和 / (2π) 的浮点残差。 */
  wrapSumTurns: number;
};

export type CutEdge = {
  kind: "cut_edge";
  id: string;
  version: 1;
  runId: string;
  source: "auto_branch_cut" | "analyst";
  endpoints: [GridCoord, GridCoord];
  pairsResidues: Array<[GridCoord, GridCoord]>;
  /** 切口两侧的整周偏移显式表示：跨该边的 k 变量键。 */
  cutVariable: string;
};

export type CycleResidual = {
  kind: "cycle_residual";
  id: string;
  version: 1;
  runId: string;
  cycle: GridCoord[];
  residualTurns: number;
  closed: boolean;
  source: "residue_plaquette" | "spanning_tree_fundamental";
};

export type RegionInfo = {
  regionId: string;
  pixelCoords: GridCoord[];
  disconnected: boolean;
};

/** 整周多解：一个候选即一棵展开树 + 跨切口整周赋值。 */
export type Candidate = {
  kind: "candidate";
  id: string;
  version: 1;
  runId: string;
  index: number;
  treeId: string;
  /** 每个跨切口整周变量的取值（显式表示，不猜）。 */
  cutAssignments: Record<string, number>;
  /** 被拒绝原因（候选被否决时非空）；未知也作为一等状态。 */
  rejection: Diagnostic | null;
  status: "legal" | "rejected" | "ambiguous";
  pistonUnknown: boolean;
  cycleResidualMax: number;
};

export type UnwrapValue = {
  kind: "unwrap_value";
  id: string;
  version: 1;
  runId: string;
  candidateId: string;
  coord: GridCoord;
  /** 展开相位（单位 rad）；低振幅/遮罩孔洞为 unknown，绝不猜测。 */
  valueRad: number | null;
  state: "ok" | "low_amplitude_hole" | "masked" | "nonclosing_region";
  /** 该值沿展开树累计的整周数，路径可追溯。 */
  wraps: number | null;
  /** 展开树路径（从根到该像素的边序列），支持路径与循环残差复查。 */
  path: Array<[GridCoord, GridCoord]>;
  directSources: Ref[];
};

export type HeightValue = {
  kind: "height_value";
  id: string;
  version: 1;
  runId: string;
  candidateId: string;
  coord: GridCoord;
  /** 高度转换链每一步都保留：phi_unwrapped -> 光程差 -> 几何灵敏度 -> 减标定面。 */
  chain: {
    unwrappedRad: number | null;
    opticalPathDelta: UnitQuantity | null;
    geometricHeight: UnitQuantity | null;
    calibrationOffset: UnitQuantity | null;
    finalHeight: UnitQuantity | null;
  };
  state: UnwrapValue["state"] | "unconvertible_unit";
};

export type UnwrapRun = {
  kind: "unwrap_run";
  id: string;
  version: 1;
  algVersion: string;
  paramsFingerprint: string;
  grid: { cols: number; rows: number };
  regions: RegionInfo[];
  scenarios: ScenarioTag[];
  /** 运行时输入角色版本（回放到旧事件时恢复这些版本）。 */
  inputVersions: {
    phase: number;
    amplitude: number;
    snr: number;
    mask: number;
    wavelength: number;
    geometry: number;
    calibration: number;
  };
  candidateIds: Ref<"candidate">[];
};

export type ScenarioTag =
  | "phase_boundary_crossing"
  | "low_amplitude_hole"
  | "multiply_connected"
  | "cycle_nonclosure"
  | "wavelength_version_change"
  | "integer_ambiguity"
  | "local_lock_conflict";

// ---------------------------------------------------------------------------
// 人工裁定 / 锁定 / 冲突
// ---------------------------------------------------------------------------

export type Decision = {
  kind: "decision";
  id: string; // evt_seq
  version: 1;
  eventSeq: number;
  scope:
    | { type: "candidate"; runId: string; candidateId: string }
    | { type: "cut_variable"; runId: string; variable: string };
  verdict: "accepted" | "rejected" | "parameter_adjustment";
  reason: string;
};

export type Lock = {
  kind: "lock";
  id: string; // evt_seq
  version: 1;
  eventSeq: number;
  runId: string;
  candidateId: string;
  coord: GridCoord;
  label: string;
  state: "active" | "defeated";
};

export type Conflict = {
  kind: "conflict";
  id: string; // evt_seq
  version: 1;
  eventSeq: number;
  runId: string;
  coord: GridCoord;
  lockRefs: Ref<"lock">[];
  resolution:
    | { type: "unresolved" }
    | { type: "winner_lock"; lockEventSeq: number; policy: string };
};

// ---------------------------------------------------------------------------
// 事件（追加式账本，哈希链防篡改，顺序是一等数据）
// ---------------------------------------------------------------------------

export type EventType =
  | "project_created"
  | "inputs_committed"
  | "import_noop_identical"
  | "params_revised"
  | "cut_edited"
  | "ran_unwrap"
  | "candidate_decided"
  | "local_locked"
  | "lock_released"
  | "conflict_detected"
  | "conflict_resolved";

export type EventPayloadMap = {
  project_created: { projectId: string; name: string; casePackId: string | null };
  inputs_committed: {
    roles: Array<{ role: string; ref: Ref; parentVersion: number | null }>;
    diagnostics: Diagnostic[];
  };
  import_noop_identical: { roles: string[] };
  params_revised: { ref: Ref<"unwrap_params">; parentVersion: number | null; changes: Record<string, number> };
  cut_edited: { ref: Ref<"cut_edit"> };
  ran_unwrap: { ref: Ref<"unwrap_run">; scenarios: ScenarioTag[] };
  candidate_decided: { ref: Ref<"decision"> };
  local_locked: { ref: Ref<"lock"> };
  lock_released: { lockEventSeq: number };
  conflict_detected: { ref: Ref<"conflict"> };
  conflict_resolved: { ref: Ref<"conflict"> };
};

export type Event<T extends EventType = EventType> = {
  seq: number;
  id: string;
  type: T;
  at: string;
  operator: string;
  payload: EventPayloadMap[T];
  prevHash: string | null;
  hash: string | null;
};

/** 任意已存储对象的判别联合。 */
export type StoredObject =
  | RawCell
  | WrappedPhaseFrame
  | AmplitudeFrame
  | SnrFrame
  | InvalidMaskFrame
  | Wavelength
  | IncidenceGeometry
  | CalibrationSurface
  | CutEdit
  | UnwrapParams
  | UnwrapRun
  | Residue
  | CutEdge
  | CycleResidual
  | UnwrapValue
  | Candidate
  | HeightValue
  | Decision
  | Lock
  | Conflict;

export type ObjectOfKind<K extends Kind> = Extract<StoredObject, { kind: K }>;

export function roleToKind(role: string): Kind {
  switch (role) {
    case "phase":
      return "wrapped_phase_frame";
    case "amplitude":
      return "amplitude_frame";
    case "snr":
      return "snr_frame";
    case "mask":
      return "invalid_mask_frame";
    case "wavelength":
      return "wavelength";
    case "geometry":
      return "incidence_geometry";
    case "calibration":
      return "calibration_surface";
    default:
      throw new Error(`未知输入角色: ${role}`);
  }
}
