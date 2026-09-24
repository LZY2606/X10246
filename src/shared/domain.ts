/**
 * 干涉条纹簿：领域数据契约（domain vocabulary）。
 *
 * 本文件只使用领域自身词汇：包裹相位像素、振幅、信噪评分、无效遮罩、
 * 波长、入射几何、标定面、切口编辑历史、残差点、支路切口、展开树、
 * 循环残差、整周候选、高度转换链、局部锁定……不使用 name/value 兜底结构。
 *
 * 所有领域量携带单位或坐标基准；原始层保留导入时的原始表示，规范化只发生在派生层。
 */

export const ALGORITHM_VERSION = "fringe-ledger/unwrapping@1.0.0";
export const HEIGHT_CHAIN_VERSION = "fringe-ledger/height-chain@1.0.0";
export const SCHEMA_VERSION = "fringe-ledger/project-bundle@1";

/** 带单位的量。raw 是导入时的原始表示，派生层才有 normalized 值。 */
export interface Dimensioned {
  value: number;
  unit: string;
  rawText?: string;
  normalized?: { value: number; unit: string; convertible: boolean; reason?: string };
  diagnostic?: string;
}

export interface GridGeometry {
  rows: number;
  cols: number;
  coordinateBasis: string; // 例如 "pixel-grid:row-down,col-right,origin=top-left"
  spacing: { dy: Dimensioned; dx: Dimensioned };
}

export type PixelStatus = "valid" | "low-amplitude" | "masked";

/** 原相位像素：逐像素保存包裹相位(rad)、原始表示与状态。一经提交不可覆盖。 */
export interface WrappedPhasePixel {
  phase: number; // [-pi, pi)
  rawPhase?: unknown; // 导入时原始表示
  status?: PixelStatus;
  diagnostic?: string;
}

export interface WrappedPhaseFrame {
  kind: "WrappedPhaseFrame";
  grid: GridGeometry;
  pixels: WrappedPhasePixel[]; // rows*cols，行优先
  wrap: { range: string; period: Dimensioned };
  sourceFile: string;
}

/** 振幅帧：低振幅像素不允许猜相位。 */
export interface AmplitudeFrame {
  kind: "AmplitudeFrame";
  grid: GridGeometry;
  values: number[];
  unit: string;
  sourceFile: string;
}

/** 信噪评分：逐像素质量证据。 */
export interface SnrScoreFrame {
  kind: "SnrScoreFrame";
  grid: GridGeometry;
  values: number[]; // 0..1
  method: string;
  sourceFile: string;
}

/** 无效遮罩：逐像素 true 表示无效；reason 逐像素说明。 */
export interface InvalidMask {
  kind: "InvalidMask";
  grid: GridGeometry;
  invalid: boolean[];
  reason: string[];
  sourceFile: string;
}

/** 波长：标量带单位；版本变更以新版本+父版本表达。 */
export interface Wavelength {
  kind: "Wavelength";
  wavelength: Dimensioned;
  band: string;
}

/** 入射几何：入射角、照明方向，全部带坐标基准。 */
export interface IncidenceGeometry {
  kind: "IncidenceGeometry";
  incidenceAngle: Dimensioned; // 与表面法线夹角
  azimuthAngle?: Dimensioned;
  sensitivityVector?: { x: number; y: number; z: number; basis: string };
}

/** 标定面：仿射高度模型 + 标定残差。 */
export interface CalibrationSurface {
  kind: "CalibrationSurface";
  model: {
    type: "plane";
    normal: { x: number; y: number; z: number; basis: string };
    offset: Dimensioned;
  };
  fitResidualRms: Dimensioned;
  referencePoints?: { row: number; col: number; height: Dimensioned }[];
}

/** 切口编辑历史：追加型，每次编辑保留操作、操作者、父操作。 */
export interface CutEdit {
  editId: string;
  parentEditId: string | null;
  op: "add-cut" | "remove-cut" | "seal-residue" | "annotate";
  between: [number, number]; // 像素索引
  note?: string;
  author: string;
}

export interface CutEditHistory {
  kind: "CutEditHistory";
  edits: CutEdit[];
}

export type SourceContent =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | SnrScoreFrame
  | InvalidMask
  | Wavelength
  | IncidenceGeometry
  | CalibrationSurface
  | CutEditHistory;

export type SourceKind = SourceContent["kind"];

// ---------- 派生实体（带算法版本、参数指纹、直接来源） ----------

/** 质量图：融合振幅/信噪，低振幅区标记，不允许猜相位。 */
export interface QualityMap {
  kind: "QualityMap";
  grid: GridGeometry;
  quality: number[]; // 0..1
  pixelState: PixelStatus[];
  lowAmplitudeThreshold: number;
}

export type ResidueCharge = 0 | 1 | -1;
/** 残差点（相位跨越边界形成的旋度）。 */
export interface Residue {
  plaquetteId: number; // (rows-1)*(cols-1) 中的索引
  anchorPixel: number;
  charge: ResidueCharge;
  loopSum: number; // rad，包裹差环绕和
}
export interface ResidueMap {
  kind: "ResidueMap";
  residues: Residue[];
  boundaries: number[]; // 发生 2π 跨越的有向边 id
}

/** 支路切口边：两侧整周偏移显式表示。 */
export interface CutEdge {
  edgeId: number;
  a: number;
  b: number;
  integerOffset: number; // 跨越该边需要加的整周数（显式）
  reason: "residue-pair" | "residue-boundary" | "manual" | "low-amplitude-hole";
  sealedBy?: string; // editId
}
export interface CutNetwork {
  kind: "CutNetwork";
  edges: CutEdge[];
  neutralizedResidues: number[];
  boundaryResidues: number[];
  components: { pixelIds: number[]; cut: boolean }[]; // 多连通区
}

export interface TreeEdge {
  edgeId: number;
  a: number;
  b: number;
  wrapDelta: number; // 包裹相位差
  chosen2Pi: number; // 所选整周 k（2π*k）
}
/** 展开树：一棵生成树 + 路径，局部一致但可能多解。 */
export interface UnwrapTree {
  treeId: string;
  label: string;
  parentTreeId: string | null;
  root: number;
  edges: TreeEdge[];
  /** 根到每个像素的展开相位（rad），非连通像素为 null */
  unwrapped: (number | null)[];
  /** 该像素整周 k 的候选集合；长度>1 即整周多解 */
  integerCandidates: number[][];
  candidateReasons: Record<string, string>;
}
export interface UnwrapResult {
  kind: "UnwrapResult";
  grid: GridGeometry;
  trees: UnwrapTree[];
  chosenTreeId: string | null;
  rejected: { treeId: string; reason: string }[];
  unknownPixels: number[]; // 低振幅孔洞：明确未知
}

/** 循环残差：展开树绕闭合回路的整周失配。 */
export interface CycleResidual {
  cycleId: string;
  pixelLoop: number[];
  wrapResidual: number; // 包裹闭合残差(rad)
  integerMismatch: number; // 整周失配 k
  closed: boolean;
  acrossCut: boolean;
  componentHole?: boolean;
}
export interface CycleResidualSet {
  kind: "CycleResidualSet";
  treeId: string;
  cycles: CycleResidual[];
}

/** 高度转换链：每一步可审计，全部带单位/基准。 */
export interface HeightChainStep {
  stepId: string;
  from: string;
  to: string;
  formula: string;
  inputs: Record<string, string>;
  outputs: { value: number; unit: string }[];
}
export interface HeightResult {
  kind: "HeightResult";
  treeId: string;
  heights: (number | null)[];
  unit: string;
  chain: HeightChainStep[];
  calibrationApplied: boolean;
  wavelengthDigest: string;
}

/** 人工决定：接受/拒绝/参数调整，写入历史并可撤销。 */
export interface ReviewDecision {
  kind: "ReviewDecision";
  decisionId: string;
  verdict: "accept" | "reject" | "parameter-adjust" | "lock-conflict-resolve";
  targetTreeId?: string;
  targetPixel?: number;
  parameterChanges?: Record<string, unknown>;
  reason: string;
  supersededBy?: string;
}

/** 局部锁定：锁定某像素/区域解读（选某棵树的整周）。 */
export interface InterpretationLock {
  kind: "InterpretationLock";
  lockId: string;
  scope: { pixels: number[]; label: string };
  treeId: string;
  pixelIntegerK: Record<string, number>;
  status: "active" | "conflict" | "released";
  conflictsWith?: string[];
}

export type DerivedContent =
  | QualityMap
  | ResidueMap
  | CutNetwork
  | UnwrapResult
  | CycleResidualSet
  | HeightResult
  | ReviewDecision
  | InterpretationLock;

export type ContentKind = SourceKind | DerivedContent["kind"];

export type ProvenanceRef = { entityId: string; version: number; digest: string };

/** 实体信封：内容 + 稳定身份 + 版本谱系 + 直接来源 + 算法/参数指纹。 */
export interface Entity<T = SourceContent | DerivedContent> {
  entityId: string; // 稳定身份（跨导出/导入保持）
  lineageId: string; // 同一逻辑实体的版本族
  version: number;
  parentVersionId: string | null;
  kind: ContentKind;
  digest: string; // 内容摘要（canonical SHA-256）
  summary: string; // 人类可读内容摘要
  algorithmVersion?: string;
  parameterFingerprint?: string;
  directSources: ProvenanceRef[];
  content: T;
  createdAt: string;
  /** 派生结果的新鲜度：当前或已过期（过期仍可查看，不能冒充当前） */
  freshness?: "current" | "stale";
  staleReason?: string;
}

// ---------- 事件（机器可读取） ----------

export type EventType =
  | "ProjectCreated"
  | "SourceCommitted"
  | "ParameterRevised"
  | "SourceLocallyChanged"
  | "CutEdited"
  | "QualityComputed"
  | "ResiduesDetected"
  | "CutsPlaced"
  | "TreesUnwrapped"
  | "CyclesEvaluated"
  | "HeightConverted"
  | "CandidateDecided"
  | "LocalLocked"
  | "LockConflictDetected"
  | "LockConflictResolved"
  | "DecisionUndone"
  | "ArchiveBaselineSaved"
  | "CounterExampleRun"
  | "CaseStepReplayed"
  | "ProjectExported"
  | "ProjectImported";

export interface EventBase {
  seq: number;
  eventId: string;
  type: EventType;
  at: string;
  seed: string;
  refs: ProvenanceRef[]; // 该事件引用的确切版本与摘要
  affected: string[]; // 受影响对象 entityId
  machine: Record<string, unknown>; // 机器可读判断依据
  note?: string;
}

export interface Project {
  projectId: string;
  title: string;
  createdAt: string;
  headSeq: number;
  schemaVersion: string;
}

export interface Bundle {
  schemaVersion: string;
  project: Project;
  events: EventBase[];
  entities: Entity[];
  blobs: Record<string, unknown>; // contentHash -> 不可变原始片段（最小/组合共享）
  counterExampleArchive: CounterExampleArchive;
  caseScript?: CaseScript;
}

// ---------- 反例档案 ----------

export type CounterScenario =
  | "phase-wrap-boundary"
  | "low-amplitude-hole"
  | "multiply-connected"
  | "cycle-nonclosure"
  | "wavelength-revision"
  | "integer-ambiguity"
  | "local-lock-conflict";

export const COUNTER_SCENARIOS: CounterScenario[] = [
  "phase-wrap-boundary",
  "low-amplitude-hole",
  "multiply-connected",
  "cycle-nonclosure",
  "wavelength-revision",
  "integer-ambiguity",
  "local-lock-conflict"
];

/** 机器可读判断事件：把领域不变量写清楚。 */
export interface InvariantJudgement {
  judgementId: string;
  invariant:
    | "no-guess-in-low-amplitude"
    | "explicit-integer-offset-across-cut"
    | "tree-local-consistency-with-path-and-cycle-residual"
    | "keep-all-legal-candidates";
  held: boolean;
  evidence: string[]; // entityId / pixel / cycleId
  detail: string;
}

export interface ScenarioRecord {
  scenario: CounterScenario;
  /** 最小输入：只改动一个直接来源 */
  minimalInput: {
    changedDirectSource: string; // 被改动的直接来源 entityId/说明
    fragmentHashes: string[];
    interpretationVersion: string;
  };
  /** 组合输入：与最小输入共享原始片段（同 hash 只存一份） */
  combinedInput: {
    fragmentHashes: string[];
    interpretationVersion: string;
  };
  accepted: { entityId: string; summary: string }[];
  rejected: { entityId: string; summary: string; reason: string }[];
  failureDiagnostics: string[];
  humanDecisions: string[]; // ReviewDecision.entityId
  affectedScope: string[]; // 受影响对象（必须限制在正确范围）
  judgements: InvariantJudgement[];
}

export interface CounterExampleArchive {
  version: string;
  baseline: {
    note: string;
    immutableSources: { kind: SourceKind; entityId: string; digest: string }[];
    savedAt: string;
  } | null;
  records: Partial<Record<CounterScenario, ScenarioRecord>>;
}

// ---------- 离线案例包叙事脚本 ----------

export interface CaseStep {
  id: string;
  title: string;
  narrative: string;
  action:
    | { type: "import" }
    | { type: "verify-baseline" }
    | { type: "trigger"; scenarios: CounterScenario[] }
    | { type: "branch-low-amplitude" }
    | { type: "final-review" }
    | { type: "lock"; pixels: number[]; treeId: string }
    | { type: "resolve-conflict"; keepLockId: string }
    | { type: "undo"; eventSeq: number }
    | { type: "time-travel"; seq: number };
  expectedAffected: string[];
}
export interface CaseScript {
  id: string;
  title: string;
  description: string;
  steps: CaseStep[];
}

export class CorruptionError extends Error {
  constructor(
    public code: "missing-reference" | "digest-mismatch" | "order-broken" | "schema",
    public detail: string
  ) {
    super(`[corruption:${code}] ${detail}`);
    this.name = "CorruptionError";
  }
}

export class FormatError extends Error {
  constructor(
    public code:
      | "grid-shape"
      | "unit-missing"
      | "coordinate-basis-missing"
      | "phase-range"
      | "length-mismatch"
      | "not-number"
      | "unknown-kind",
    public detail: string,
    public path: string
  ) {
    super(`[format:${code}] ${detail} @ ${path}`);
    this.name = "FormatError";
  }
}
