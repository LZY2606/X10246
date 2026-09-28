import type { AngleUnit, CoordinateBasis, LengthUnit, RatioUnit, Unit } from "./units.ts";

/* ================= 通用 ================= */

export interface Quantity {
  value: number;
  unit: Unit;
}

export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}

export type RevisionStatus = "current" | "superseded";

/** 不可变修订：原始输入一经提交不可覆盖，修订以新版本 + 父版本关系表达。 */
export interface Revision<T> {
  revisionId: string; // 内容寻址，导出/再导入后稳定
  kind: string;
  parentRevisionId: string | null;
  content: T;
  contentHash: string;
  createdAt: string;
  status: RevisionStatus;
}

export interface ProvenanceEdge {
  fromRevisionId: string; // 派生/决定方
  toRevisionId: string; // 直接来源
  role: string;
}

/* ================= 输入实体（不可覆盖） ================= */

export interface GridData {
  width: number;
  height: number;
  basis: CoordinateBasis;
  /** 行主序；null 表示该像素无效/未知 */
  values: (number | null)[];
}

/** 原相位像素：包裹相位，原始表示保留单位 */
export interface WrappedPhasePixels {
  grid: GridData;
  unit: AngleUnit; // rad | deg | fringe
  instrumentId?: string;
}

/** 信噪评分（质量图来源之一） */
export interface SignalQualityScore {
  grid: GridData;
  unit: RatioUnit; // ratio, 0..1
  metric: "modulation" | "snr" | "coherence";
}

/** 无效遮罩 */
export interface InvalidMask {
  grid: GridData; // 1=有效 0=无效
  reason?: string;
}

/** 波长（版本化，变更只影响高度链） */
export interface WavelengthSpec {
  value: number;
  unit: LengthUnit;
  source: string; // 例如 "laser-calibration-sheet"
}

/** 入射几何 */
export interface IncidenceGeometry {
  kind: "normal" | "oblique";
  incidenceAngle: Quantity; // 相对样品法线
  azimuthDeg?: number;
}

/** 标定面（Z 参考平面） */
export interface CalibrationPlane {
  coefficients: [number, number, number]; // z = a*x + b*y + c，单位 nm
  unit: LengthUnit;
  reference: string; // 标定帧来源
}

/** 切口编辑历史（追加式，不可覆盖） */
export interface CutEditHistory {
  entries: CutEditEntry[];
}

export interface CutEditEntry {
  seq: number;
  action: "add" | "remove";
  /** 折线像素坐标 [[x,y],...] */
  polyline: [number, number][];
  author: string;
  note?: string;
}

export type InputKind =
  | "wrapped-phase"
  | "quality-score"
  | "invalid-mask"
  | "wavelength"
  | "incidence-geometry"
  | "calibration-plane"
  | "cut-history";

export const INPUT_KINDS: InputKind[] = [
  "wrapped-phase",
  "quality-score",
  "invalid-mask",
  "wavelength",
  "incidence-geometry",
  "calibration-plane",
  "cut-history",
];

/* ================= 派生/决定实体 ================= */

export interface CutSegment {
  cutId: string;
  polyline: [number, number][];
  source: "residue-auto" | "manual";
}

/** 切口网络 */
export interface CutNetwork {
  segments: CutSegment[];
  residueCount: number;
  pairedResidues: number;
}

/** 支路切口两侧的整周偏移（显式表示） */
export interface CutSideOffset {
  cutId: string;
  /** 沿切口采样点的左右两侧整周差 k_right - k_left */
  samples: { at: [number, number]; kLeft: number; kRight: number; deltaK: number }[];
}

/** 循环残差（环绕切口/回路的相位不闭合量，单位 fringe） */
export interface CycleResidual {
  loopId: string;
  path: [number, number][];
  residualFringe: number;
  closed: boolean;
}

export type RejectionReason =
  | "LOW_AMPLITUDE_NO_GUESS" // 低振幅区域不得猜相位
  | "MASKED_INVALID"
  | "CYCLE_NOT_CLOSED"
  | "LOCK_CONFLICT"
  | "STALE_DEPENDENCY";

/** 展开候选：不同展开树可得到局部一致解，全部保留 */
export interface UnwrapCandidate {
  candidateId: string;
  treeRoot: [number, number];
  spanningTree: string; // 树结构摘要（边列表哈希）
  /** 整周场 k(x,y)，与相位相加得绝对相位；null = 未解出 */
  integerField: (number | null)[];
  gridWidth: number;
  gridHeight: number;
  regionCount: number;
  cutSideOffsets: CutSideOffset[];
  cycleResiduals: CycleResidual[];
  rejected: { region: [number, number][]; reason: RejectionReason }[];
  unknown: [number, number][]; // 低振幅等未知像素
  consistentWithLocks: boolean;
}

/** 整周多解：某区域存在多个合法 k 偏移 */
export interface IntegerAmbiguity {
  regionId: string;
  pixels: [number, number][];
  legalOffsets: number[]; // 合法整周偏移候选
  chosenOffset: number | null; // 未决定时为 null
}

/** 局部锁定 */
export interface LocalLock {
  lockId: string;
  region: [number, number][];
  candidateId: string;
  integerOffset: number;
  author: string;
  rationale: string;
  state: "active" | "reverted" | "conflicted";
}

/** 高度转换链：包裹→展开候选→OPD→高度 */
export interface HeightMap {
  grid: GridData; // 单位 nm 的样品坐标高度；null=未知
  unit: LengthUnit;
  basis: CoordinateBasis;
  wavelengthRevisionId: string;
  geometryRevisionId: string;
  calibrationRevisionId: string;
  candidateId: string;
  opdFormula: string; // 例如 "opd = phi*lambda/(2*pi); h = opd/(1+cos(theta)) - plane"
  unconverted: { at: [number, number]; diagnostic: string }[];
}

export type DerivedKind =
  | "cut-network"
  | "unwrap-candidate"
  | "integer-ambiguity"
  | "local-lock"
  | "height-map";

/** 派生记录：算法版本 + 参数指纹 + 直接来源 */
export interface DerivedRecord<T> {
  revisionId: string;
  kind: DerivedKind;
  algorithm: string;
  algorithmVersion: string;
  paramFingerprint: string;
  directSourceIds: string[];
  content: T;
  stale: boolean;
  staleReason?: string;
  createdAt: string;
}

/* ================= 事件（判断依据，机器可读） ================= */

export type EventType =
  | "project.created"
  | "input.imported"
  | "input.revised"
  | "input.rejected"
  | "derived.computed"
  | "derived.invalidated"
  | "decision.lock"
  | "decision.unlock"
  | "decision.accept"
  | "decision.reject"
  | "decision.param-change"
  | "conflict.detected"
  | "conflict.resolved"
  | "review.time-travel"
  | "export.created"
  | "import.completed";

export interface DomainEvent {
  eventId: string;
  seq: number;
  at: string;
  type: EventType;
  actor: string;
  /** 判断依据（机器可读），例如 LOW_AMPLITUDE_NO_GUESS */
  rationaleCode?: string;
  subjectIds: string[];
  payload: Record<string, unknown>;
}

/* ================= 反例档案 ================= */

export type CounterexampleScenario =
  | "phase-crosses-boundary"
  | "low-amplitude-holes"
  | "multi-connected-region"
  | "cycle-not-closed"
  | "wavelength-version-change"
  | "integer-multi-solution"
  | "local-lock-conflict";

export const SCENARIOS: CounterexampleScenario[] = [
  "phase-crosses-boundary",
  "low-amplitude-holes",
  "multi-connected-region",
  "cycle-not-closed",
  "wavelength-version-change",
  "integer-multi-solution",
  "local-lock-conflict",
];

export interface CounterexampleCase {
  scenario: CounterexampleScenario;
  minimalInputIds: string[];
  combinedInputIds: string[];
  acceptedResultIds: string[];
  rejectedResultIds: string[];
  expectedRationale: string[];
  /** 单源改动应被限制影响的范围（revisionId 前缀或 kind） */
  expectedImpactScope: string[];
}

/* ================= 查询 ================= */

export interface EntitySummary {
  revisionId: string;
  kind: string;
  contentHash: string;
  digest: string; // 内容摘要
  references: string[]; // 引用的版本号
  status: RevisionStatus | "derived" | "derived-stale";
}

export class CorruptReferenceError extends Error {
  constructor(
    public readonly fromId: string,
    public readonly missingId: string,
  ) {
    super(`CORRUPT_REFERENCE: ${fromId} 引用了不存在的版本 ${missingId}（禁止退回当前最新版）`);
    this.name = "CorruptReferenceError";
  }
}
