// 干涉条纹簿 —— 领域核心词汇表
// 直接采用光学干涉 / 相位展开 / 标定领域自身的词汇，不使用 name/value 泛化。

export type ScalarUnit =
  | 'rad'
  | 'cycle'
  | 'nm'
  | 'um'
  | 'mm'
  | 'dimensionless'
  | 'count'
  | 'ratio'
  | 'degree';

// 坐标基准：像素锚点或物理标定基准。所有领域量都必须携带单位或坐标基准。
export interface PhysicalFrame {
  kind: 'pixel-grid' | 'calibration-plane' | 'sensor';
  originAnchor: PixelAnchor;
  pixelPitchUM?: { x: number; y: number };
  axes: 'row-col';
}

export interface PixelAnchor {
  row: number;
  col: number;
  note: string;
}

export interface Quantity {
  value: number;
  unit: ScalarUnit;
  coordinateFrame?: PhysicalFrame;
}

// 原始表示：导入时保留原始表示，派生层才做规范化。
export interface RawRepresentation {
  rawText: string;
  originalUnit: ScalarUnit | null;
  representation: 'scalar' | '2d-grid' | 'geometry' | 'json-block';
}

// 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。
export interface NormalizationDiagnostic {
  code: string;
  at: string;
  message: string;
  rawText?: string;
  keptAtOriginalPosition: boolean;
}

export interface SharedFragment {
  entityType: 'shared-fragment';
  id: string;
  contentHash: string;
  kind: 'grid-tile' | 'parameter-block' | 'calibration-block' | 'geometry-block';
  role: string;
  raw: RawRepresentation;
  bytes: number[] | null;
  shape: { rows: number; cols: number } | null;
}

export type FrameUnit = 'rad' | 'ratio' | 'mask' | 'count' | 'um';

export interface Grid2D {
  rows: number;
  cols: number;
  values: number[]; // 长度 = rows*cols，按行优先；派生网格
  unit: FrameUnit;
  coordinateFrame: PhysicalFrame;
}

// ---------- 输入实体（一经提交不可覆盖）----------

export interface WrappedPhaseFrame {
  entityType: 'wrapped-phase-frame';
  id: string;
  contentHash: string;
  label: string;
  rows: number;
  cols: number;
  // 原相位像素：保留原始字符串表示（导入时保留原始表示）
  pixels: number[];
  pixelRawText: string[];
  unit: 'rad';
  wrapRange: '[-pi,pi)';
  coordinateFrame: PhysicalFrame;
  parentVersionId: string | null;
  versionIndex: number;
  revisionReason: string | null;
  fragments: string[];
  createdAt: string;
}

export interface AmplitudeFrame {
  entityType: 'amplitude-frame';
  id: string;
  contentHash: string;
  label: string;
  rows: number;
  cols: number;
  values: number[];
  rawText: string[];
  unit: 'ratio';
  scale: string;
  coordinateFrame: PhysicalFrame;
  parentVersionId: string | null;
  versionIndex: number;
  fragments: string[];
  createdAt: string;
}

export interface InvalidMask {
  entityType: 'invalid-mask';
  id: string;
  contentHash: string;
  label: string;
  rows: number;
  cols: number;
  invalid: number[]; // 1 = 无效像素
  rawText: string[];
  coordinateFrame: PhysicalFrame;
  parentVersionId: string | null;
  versionIndex: number;
  fragments: string[];
  createdAt: string;
}

export interface SnrScoreMap {
  entityType: 'snr-score-map';
  id: string;
  contentHash: string;
  label: string;
  rows: number;
  cols: number;
  scores: number[]; // 信噪评分 0..1（或 >1 的分贝归一）
  rawText: string[];
  unit: 'ratio';
  coordinateFrame: PhysicalFrame;
  parentVersionId: string | null;
  versionIndex: number;
  fragments: string[];
  createdAt: string;
}

export interface WavelengthVersion {
  entityType: 'wavelength-version';
  id: string;
  contentHash: string;
  label: string;
  wavelengthNM: number;
  raw: RawRepresentation;
  parentVersionId: string | null;
  versionIndex: number;
  supersedes: string | null;
  createdAt: string;
}

export interface IncidenceGeometry {
  entityType: 'incidence-geometry';
  id: string;
  contentHash: string;
  label: string;
  // 入射几何：光源/观察方向余弦与波长敏感系数
  sensitivityVector: { kx: number; ky: number; kz: number };
  angleOfIncidenceDeg: number | null;
  raw: RawRepresentation;
  normalizationDiagnostics: NormalizationDiagnostic[];
  parentVersionId: string | null;
  versionIndex: number;
  createdAt: string;
}

export interface CalibrationSurface {
  entityType: 'calibration-surface';
  id: string;
  contentHash: string;
  label: string;
  rows: number;
  cols: number;
  // 标定面：已知平面/参考面的展开相位（本身仍可有整周未定）
  referenceUnwrappedRad: number[];
  raw: RawRepresentation;
  planeModel: { z0: number; slopeX: number; slopeY: number } | null;
  coordinateFrame: PhysicalFrame;
  parentVersionId: string | null;
  versionIndex: number;
  createdAt: string;
}

export interface CutEdit {
  editId: string;
  at: string;
  action: 'add' | 'remove';
  endpoints: [number, number][]; // 支路切口端点（像素坐标）
  reason: string;
  by: 'human' | 'auto';
}

export interface CutEditHistory {
  entityType: 'cut-edit-history';
  id: string;
  contentHash: string;
  label: string;
  // 切口编辑历史不可覆盖：仅追加
  edits: CutEdit[];
  parentVersionId: string | null;
  versionIndex: number;
  createdAt: string;
}

export type ImmutableInputEntity =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | InvalidMask
  | SnrScoreMap
  | WavelengthVersion
  | IncidenceGeometry
  | CalibrationSurface
  | CutEditHistory
  | SharedFragment;

// ---------- 派生实体（带算法版本、参数指纹与直接来源）----------

export type DerivedStatus = 'current' | 'stale' | 'unknown' | 'rejected';

export interface ResidueCharge {
  row: number;
  col: number;
  charge: 1 | -1; // 2x2 回路包裹梯度和 / 2pi
  closedRad: number;
}

export interface ResidueMap {
  entityType: 'residue-map';
  id: string;
  contentHash: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  directSources: string[];
  status: DerivedStatus;
  residues: ResidueCharge[];
  unknownPixels: string[]; // 低振幅孔洞：不得猜相位 -> unknown
  createdAt: string;
}

export interface CutSegment {
  id: string;
  from: [number, number];
  to: [number, number];
  sourceEditIds: string[];
  kind: 'auto-balanced' | 'human' | 'boundary';
}

export interface BranchCutNetwork {
  entityType: 'branch-cut-network';
  id: string;
  contentHash: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  directSources: string[];
  status: DerivedStatus;
  cuts: CutSegment[];
  balanceReport: { positive: number; negative: number; unbalanced: number };
  createdAt: string;
}

export interface QualityMap {
  entityType: 'quality-map';
  id: string;
  contentHash: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  directSources: string[];
  status: DerivedStatus;
  rows: number;
  cols: number;
  quality: number[]; // 质量图（相位导数方差 + 振幅/SNR 融合）
  unit: 'ratio';
  noGuess: number[]; // 1 = 禁止猜测（低振幅/无效）
  createdAt: string;
}

// 切口两侧的整周偏移要显式表示
export interface CycleOffset {
  edge: { a: [number, number]; b: [number, number] };
  integerCycles: number; // phi_b - phi_a 的整周数（显式）
  wrappedRad: number;
  isCut: boolean;
}

export interface CycleResidual {
  cycleId: string;
  pixels: [number, number][];
  closureRad: number; // 回路残差（rad）
  integerCycles: number;
  fractionalRad: number;
  closes: boolean; // |closureRad - 2*pi*k| <= tol
  crossesCut: boolean;
  treePath: [number, number][];
}

export interface TreePath {
  from: [number, number];
  to: [number, number];
  pixelPath: [number, number][];
  accumulatedCycles: number;
}

export interface UnwrapCandidate {
  candidateId: string;
  treeAlgorithm: 'bfs-quality' | 'min-cut-tree';
  regionIndex: number;
  rootAnchor: [number, number];
  // 不同展开树可得到局部一致解：保留全部合法候选
  unwrappedRad: number[];
  unknownPixels: string[];
  treePaths: TreePath[];
  cycleResiduals: CycleResidual[];
  cuts: CycleOffset[];
  regionOffsets: Record<number, number>; // 多连通区之间的相对整周偏移候选
  legal: boolean;
  rejectReasons: string[];
  ambiguity: 'unique' | 'multiple';
}

export interface UnwrapResult {
  entityType: 'unwrap-result';
  id: string;
  contentHash: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  directSources: string[];
  status: DerivedStatus;
  rows: number;
  cols: number;
  connectedRegions: { id: number; pixels: string[] }[];
  candidates: UnwrapCandidate[];
  acceptedCandidateId: string | null;
  lockedLocalPixels: Record<string, string>; // pixel -> candidateId（局部锁定）
  diagnostics: string[];
  createdAt: string;
}

export interface HeightSurface {
  entityType: 'height-surface';
  id: string;
  contentHash: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  directSources: string[];
  status: DerivedStatus;
  rows: number;
  cols: number;
  heightNM: number[];
  unknownPixels: string[];
  // 高度转换链：展开相位 -> 光程差 -> 几何高度，每一步保留
  chain: {
    phaseToOPDFactor: number; // lambda/(2*pi)*... (nm/rad)
    opdToHeightFactor: number; // 1/(kx+ky+kz 投影)
    wavelengthId: string;
    geometryId: string;
    calibrationId: string | null;
  };
  createdAt: string;
}

export interface ReviewLock {
  entityType: 'review-lock';
  id: string;
  contentHash: string;
  pixel: [number, number];
  candidateId: string;
  unwrapResultId: string;
  rationale: string;
  createdAt: string;
}

export type DerivedEntity =
  | ResidueMap
  | BranchCutNetwork
  | QualityMap
  | UnwrapResult
  | HeightSurface
  | ReviewLock;

export type Entity = ImmutableInputEntity | DerivedEntity;

// ---------- 事件历史（机器可读取；冲突解决与撤销也写入历史）----------

export type EventType =
  | 'input-imported'
  | 'input-revised'
  | 'pipeline-computed'
  | 'candidate-generated'
  | 'candidate-rejected'
  | 'candidate-accepted'
  | 'local-lock-set'
  | 'local-lock-conflict'
  | 'local-lock-released'
  | 'parameter-adjusted'
  | 'cut-edited'
  | 'source-changed-local'
  | 'wavelength-version-changed'
  | 'review-undone'
  | 'replay-visited'
  | 'exported'
  | 'imported';

export interface EventRecord {
  eventId: string;
  seq: number;
  at: string; // 虚拟时间 ISO 字符串
  virtualTick: number;
  type: EventType;
  scenario: string | null;
  subject: string; // 主要实体 id
  refs: string[]; // 该事件依赖的精确版本（不可用最新版替代）
  payload: Record<string, unknown>;
  adopted: boolean; // 被采纳 / 未采纳的结果都保留
  undoneOf: string | null;
}

// ---------- 反例场景 ----------

export type CounterexampleScenario =
  | 'phase-crossing-boundary'
  | 'low-amplitude-hole'
  | 'multiply-connected-region'
  | 'cycle-nonclosure'
  | 'wavelength-version-change'
  | 'integer-cycle-multiplicity'
  | 'local-lock-conflict';

export interface CounterexampleCase {
  scenario: CounterexampleScenario;
  minimalInputId: string;
  combinedInputId: string;
  sharedFragmentIds: string[];
  expected: {
    affectedScope: string[]; // 影响应被限制的对象 id 前缀
    invariant: string; // 机器可读不变量
  };
  interpretations: {
    inputId: string;
    interpretationVersion: string;
    failureDiagnostics: string[];
    humanDecision: string | null;
    adopted: boolean;
  }[];
}

// ---------- 查询 / 溯源 ----------

export interface VersionRef {
  entityId: string;
  versionIndex: number;
  contentHash: string;
  kind: string;
  summary: string;
}

export interface ProvenanceView {
  entityId: string;
  kind: string;
  contentHash: string;
  status: DerivedStatus | 'immutable';
  algorithmVersion?: string;
  parameterFingerprint?: string;
  directSources: VersionRef[];
  generatingEvent: EventRecord | null;
  summary: string;
}

export class IntegrityError extends Error {
  constructor(
    public code:
      | 'DANGLING_REFERENCE'
      | 'HASH_MISMATCH'
      | 'IMMUTABLE_OVERWRITE'
      | 'FORMAT_ERROR'
      | 'LOCK_CONFLICT'
      | 'UNCONVERTIBLE_VALUE',
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'IntegrityError';
  }
}

export interface ProjectSnapshot {
  format: 'fringebook-project';
  formatVersion: 1;
  projectId: string;
  exportedAt: string;
  virtualTick: number;
  entities: Entity[];
  events: EventRecord[];
  counterexamples: CounterexampleCase[];
}
