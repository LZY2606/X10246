/**
 * 干涉条纹簿 · 数据契约（领域词汇）
 *
 * 这里刻意不使用 name/value 通用表：每个实体都以干涉测量/相位展开/标定领域
 * 自己的概念命名（包裹相位、振幅、无效遮罩、波长、入射几何、标定面、残差点、
 * 支路切口、展开树、循环残差、整周候选、高度链、局部锁定……）。
 *
 * 不变量：
 *  - 原始输入实体一经提交不可覆盖（immutable + 版本链 parentId）。
 *  - 每个派生实体携带算法版本、参数指纹与“直接来源引用”。
 *  - 任何实体都用稳定身份（StableId）寻址；顺序由版本号/事件序号保证。
 */

export type StableId = string;
export type Iso8601 = string;
export type UnitName = string;

export interface PhysicalScalar {
  value: number;
  unit: UnitName;
}

export interface Pixel {
  r: number;
  c: number;
}

export interface PixelRect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** 坐标基准：像素坐标如何映射到物理坐标（所有几何量都要带坐标基准） */
export interface GridSpec {
  rows: number;
  cols: number;
  origin: Pixel;
  pixelPitch: { dr: PhysicalScalar; dc: PhysicalScalar };
  axisUnit: UnitName;
}

export interface BoundaryEdge {
  a: Pixel;
  b: Pixel;
  /** 包裹相位在该相邻对观测到的跨越（主值差），单位 rad */
  wrappedStepRad: number;
  kind: "horizontal" | "vertical";
}

/** 原始单元格：保留导入时的原始表示；无法规范化的值留在原位并附诊断 */
export interface RawCell {
  /** 导入文本/数值的原始表示，例如 "-3.14159"、"N/A"、"0.72" */
  raw: string;
  /** 规范化后的数值；无法转换时为 null（绝不猜测填充） */
  value: number | null;
  issue?: string;
}

export type FrameKind =
  | "wrappedPhase"
  | "amplitude"
  | "snrScore"
  | "invalidMask"
  | "unwrappedPhase"
  | "quality"
  | "height";

interface EntityBase {
  id: StableId;
  version: number;
  parentId: StableId | null;
  committedAt: Iso8601;
  contentHash: string;
}

/** 包裹相位帧（原始输入，rad，主值区间） */
export interface WrappedPhaseFrame extends EntityBase {
  kind: "wrappedPhase";
  grid: GridSpec;
  representation: {
    unit: "rad";
    convention: "half-open[-pi,pi)" | "half-open[0,2pi)";
    encoding: string;
  };
  cells: RawCell[];
  provenance: { sourceName: string; byteHash: string | null };
}

/** 振幅帧（原始输入；低振幅区域用于“不猜相位”判定） */
export interface AmplitudeFrame extends EntityBase {
  kind: "amplitude";
  grid: GridSpec;
  unit: UnitName;
  cells: RawCell[];
  provenance: { sourceName: string; byteHash: string | null };
}

/** 信噪比评分帧（原始输入；可给 dB 或无量纲评分，导入保留原始单位） */
export interface SnrScoreFrame extends EntityBase {
  kind: "snrScore";
  grid: GridSpec;
  unit: UnitName;
  cells: RawCell[];
  provenance: { sourceName: string; byteHash: string | null };
}

/** 无效遮罩（原始输入；true = 无效/遮罩孔洞，不作为相位数据） */
export interface InvalidMask extends EntityBase {
  kind: "invalidMask";
  grid: GridSpec;
  cells: RawCell[];
  markedBy: "operator" | "imported";
  provenance: { sourceName: string; byteHash: string | null };
}

/** 波长（版本化；波长版本变更只应令高度链结果过期） */
export interface Wavelength extends EntityBase {
  kind: "wavelength";
  lambda: PhysicalScalar;
  /** 导入时原始表示（如 "632.8 nm"），规范化不覆盖原文 */
  rawRepresentation: { text: string; value: number | null; unit: UnitName | null; issue?: string };
  changeReason: string | null;
}

/** 入射几何：入射角/方位角与观察方向，带角度单位与坐标基准名 */
export interface IncidenceGeometry extends EntityBase {
  kind: "incidenceGeometry";
  incidence: PhysicalScalar;
  azimuth: PhysicalScalar;
  observation: "normal" | "specular-arm";
  coordBasis: string;
  rawRepresentation: { incidenceText: string; azimuthText: string };
  changeReason: string | null;
}

/** 标定面（平面：z = a*x + b*y + c，物理坐标下，带单位与基准） */
export interface CalibrationPlane extends EntityBase {
  kind: "calibrationPlane";
  grid: GridSpec;
  coefficients: { a: PhysicalScalar; b: PhysicalScalar; c: PhysicalScalar };
  coordBasis: string;
  fitResidual: PhysicalScalar;
  frameSource: string;
  rawRepresentation: { lines: string[] };
  changeReason: string | null;
}

export type InputEntity =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | SnrScoreFrame
  | InvalidMask
  | Wavelength
  | IncidenceGeometry
  | CalibrationPlane;

export type InputEntityKind = InputEntity["kind"];

/* ---------------------------------- 派生层 --------------------------------- */

export interface SourceRef {
  kind: FrameKind | InputEntityKind | DerivedEntityKind | "cutEdit" | "candidate" | "lock";
  id: StableId;
  version: number;
  contentHash?: string;
}

export interface Provenance {
  algorithm: string;
  algorithmVersion: string;
  paramsFingerprint: string;
  sources: SourceRef[];
  /** 该结果依赖的网格范围（用于“局部输入变化只令依赖它的结果过期”） */
  footprint: PixelRect[];
}

export interface QualityMap {
  id: StableId;
  kind: "quality";
  committedAt: Iso8601;
  provenance: Provenance;
  /** 0..1；遮罩/缺失/低振幅判废处为 null（未知，不用来画图时插值） */
  cells: (number | null)[];
  unknownReason: (string | null)[];
}

export type PlaquetteCharge = -1 | 0 | 1 | null;

export interface ResidueMap {
  id: StableId;
  kind: "residueMap";
  committedAt: Iso8601;
  provenance: Provenance;
  /** 尺寸 (rows-1) x (cols-1)，行优先；null = 含无效像素，无法判定 */
  charges: PlaquetteCharge[];
  positiveCount: number;
  negativeCount: number;
  wrapEdges: BoundaryEdge[];
}

export interface CutEdge {
  id: StableId;
  a: Pixel;
  b: Pixel;
  reason:
    | "residue-dipole"
    | "unpaired-to-border"
    | "unpaired-to-hole"
    | "operator-marked"
    | "nyquist-violation";
  links: StableId[];
  /** 切口两侧的显式整周偏移（cycles，相对整周数 k 的跳变）；未知为 null */
  jumpCycles: number | null;
  edited: boolean;
}

export interface CutNetwork {
  id: StableId;
  kind: "cutNetwork";
  committedAt: Iso8601;
  provenance: Provenance;
  cuts: CutEdge[];
  neutral: boolean;
  openChargeCount: number;
}

export interface TreeEdge {
  a: Pixel;
  b: Pixel;
  /** 沿树 a→b 的显式整周增量 Δk（整数） */
  deltaK: number;
  /** 包裹主值梯度 rad */
  wrappedGradientRad: number;
}

export interface UnwrapTree {
  id: StableId;
  kind: "unwrapTree";
  committedAt: Iso8601;
  provenance: Provenance;
  root: Pixel;
  component: number;
  edges: TreeEdge[];
  pixels: Pixel[];
}

export interface UnwrappedPhaseFrame {
  id: StableId;
  kind: "unwrappedPhase";
  committedAt: Iso8601;
  provenance: Provenance;
  /** 连续相位 rad；无效/低振幅判废处为 null（不得猜相位） */
  phaseRad: (number | null)[];
  /** 每个像素相对其包裹主值的显式整周数 k：Ψ = φ + 2πk；null = 未决定 */
  kField: (number | null)[];
  componentOf: (number | null)[];
  trees: UnwrapTree[];
}

export interface NonTreeCycle {
  a: Pixel;
  b: Pixel;
  cut: boolean;
  /** 树路径给出的相位差 rad */
  treeDeltaRad: number;
  /** 直接包裹梯度 rad */
  wrappedGradientRad: number;
  /** 残差（cycles）；闭合时整数部分应与切口显式 jumpCycles 一致，分数部分≈0 */
  residualCycles: number;
  closes: boolean;
  expectedJumpCycles: number | null;
}

export interface CycleResidualMap {
  id: StableId;
  kind: "cycleResidual";
  committedAt: Iso8601;
  provenance: Provenance;
  cycles: NonTreeCycle[];
  maxAbsFraction: number;
  globallyConsistent: boolean;
}

export type CandidateStatus = "unique" | "ambiguous" | "unknown";

export interface IntegerCandidate {
  id: StableId;
  kind: "integerCandidate";
  committedAt: Iso8601;
  provenance: Provenance;
  target: Pixel;
  component: number;
  /** 全部合法整周候选 k；无法唯一决定时保留全部，不静默丢弃 */
  legalK: number[];
  adoptedK: number | null;
  rejected: { k: number; reason: string }[];
  status: CandidateStatus;
  ambiguityReason: string | null;
}

export interface HeightChainStep {
  step: string;
  formula: string;
  inputs: SourceRef[];
  unit: UnitName;
}

export interface HeightField {
  id: StableId;
  kind: "height";
  committedAt: Iso8601;
  provenance: Provenance;
  heightM: (number | null)[];
  rawOpdM: (number | null)[];
  planeResidualM: (number | null)[];
  chain: HeightChainStep[];
}

export type DerivedEntityKind =
  | "quality"
  | "residueMap"
  | "cutNetwork"
  | "unwrappedPhase"
  | "cycleResidual"
  | "integerCandidate"
  | "height";

export type DerivedEntity =
  | QualityMap
  | ResidueMap
  | CutNetwork
  | UnwrappedPhaseFrame
  | CycleResidualMap
  | IntegerCandidate
  | HeightField;

/* --------------------------------- 人工决定 -------------------------------- */

export interface LocalLock {
  id: StableId;
  kind: "lock";
  committedAt: Iso8601;
  target:
    | { scope: "pixel"; pixel: Pixel }
    | { scope: "component"; component: number };
  interpretation: {
    treeId: StableId | null;
    candidateId: StableId | null;
    k: number | null;
    note: string;
  };
  status: "active" | "released" | "conflict";
  conflictsWith: StableId[];
  basedOnEventSeq: number;
}

export type Verdict = "accept" | "reject" | "adjust";

/* --------------------------------- 事件日志 -------------------------------- */

export type EventType =
  | "projectCreated"
  | "inputCommitted"
  | "inputSuperseded"
  | "formatDiagnostic"
  | "derivedProduced"
  | "derivedInvalidated"
  | "cutEdited"
  | "candidateAdopted"
  | "candidateRejected"
  | "localLocked"
  | "lockReleased"
  | "lockConflictDetected"
  | "reviewDecision"
  | "projectExported"
  | "bundleImported"
  | "caseCheckpoint";

export interface JournalEvent {
  seq: number;
  id: StableId;
  at: Iso8601;
  logicalClock: number;
  type: EventType;
  summary: string;
  payload: Record<string, unknown>;
}

export interface EntityRefSummary {
  ref: SourceRef;
  contentSummary: string;
}

export interface ValidationDiagnostic {
  code: string;
  message: string;
  fatal: boolean;
  at: Iso8601;
  rawPosition?: Pixel;
  rawSnippet?: string;
}

export class CorruptReferenceError extends Error {
  constructor(
    public readonly missing: SourceRef,
    public readonly referrer: StableId,
  ) {
    super(
      `损坏的引用：${referrer} 引用 ${missing.kind}#${missing.id}@v${missing.version}，该版本不存在（禁止回退到最新版）`,
    );
    this.name = "CorruptReferenceError";
  }
}
