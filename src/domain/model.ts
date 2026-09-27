// 领域模型：直接采用光学干涉/相位展开/标定词汇，不压成 name/value。
import type { CoordFrame, GridQuantity, Quantity, Unit } from './core.ts';

// ---------------------------------------------------------------------------
// 输入实体（一经提交不可覆盖；修订 = 新版本 + 父版本关系）
// ---------------------------------------------------------------------------

/** 原相位像素：包裹相位场，单位 rad，坐标基准 pixel。 */
export interface WrappedPhaseField {
  kind: 'WrappedPhaseField';
  phase: GridQuantity; // rad, pixel
  sourceLabel: string; // 原始表示（导入时的文件/样例标签）
}

/** 信噪评分 / 质量图。 */
export interface QualityMap {
  kind: 'QualityMap';
  snr: GridQuantity; // ratio, pixel
  lowAmplitudeThreshold: Quantity; // ratio
}

/** 无效遮罩。 */
export interface InvalidMask {
  kind: 'InvalidMask';
  mask: boolean[][]; // true = 无效
  frame: CoordFrame;
}

/** 波长（标定链版本化对象）。 */
export interface WavelengthSpec {
  kind: 'WavelengthSpec';
  wavelength: Quantity; // nm/um...
  laserLabel: string;
}

/** 入射几何。 */
export interface IncidenceGeometry {
  kind: 'IncidenceGeometry';
  incidenceAngle: Quantity; // deg/rad
  azimuth: Quantity;
}

/** 标定面。 */
export interface CalibrationPlane {
  kind: 'CalibrationPlane';
  // ax + by + c（单位 um，坐标基准 lab）
  a: Quantity;
  b: Quantity;
  c: Quantity;
}

/** 切口编辑历史：有序、不可覆盖，只能追加新版本。 */
export interface CutEditHistory {
  kind: 'CutEditHistory';
  cuts: BranchCut[];
}

export interface BranchCut {
  cutId: string;
  /** 切口折线（像素坐标）。 */
  polyline: Array<[number, number]>;
  author: string;
  note: string;
}

export type InputEntityBody =
  | WrappedPhaseField
  | QualityMap
  | InvalidMask
  | WavelengthSpec
  | IncidenceGeometry
  | CalibrationPlane
  | CutEditHistory;

export type InputKind = InputEntityBody['kind'];

// ---------------------------------------------------------------------------
// 决定实体（展开候选、整周偏移、循环残差、局部锁定、高度转换链）
// ---------------------------------------------------------------------------

/** 切口两侧的整周偏移：显式表示。 */
export interface CutOffset {
  cutId: string;
  sideA: string; // 切口两侧区域的稳定身份
  sideB: string;
  k: number; // 整周数，可正可负
}

/** 一条展开路径（树）产生的候选解。 */
export interface UnwrapCandidate {
  candidateId: string;
  treeId: string;
  componentId: string;
  /** 解出的连续相位（rad, pixel）；低振幅/无效像素为 null —— 不得猜相位。 */
  unwrapped: (number | null)[][];
  offsets: CutOffset[];
  /** 路径：从种子到各像素的遍历顺序摘要（首末 + 长度），供复查。 */
  pathDigest: string;
  cycleResiduals: CycleResidual[];
  status: 'open' | 'accepted' | 'rejected';
  rejectReason?: string;
}

/** 循环残差：沿闭合回路积分包裹相位梯度，非零即不闭合。 */
export interface CycleResidual {
  cycleId: string;
  loop: Array<[number, number]>;
  residual: Quantity; // rad
  closes: boolean;
}

/** 局部锁定：审阅者锁定某区域的某候选解。 */
export interface LocalLock {
  lockId: string;
  componentId: string;
  candidateId: string;
  lockedOffsets: CutOffset[];
  active: boolean;
}

/** 高度转换链：相位 -> 高度，携带波长版本与入射几何版本。 */
export interface HeightConversion {
  chainId: string;
  candidateId: string;
  wavelengthVersionId: string;
  geometryVersionId: string;
  calibrationVersionId: string;
  height: GridQuantity; // um, lab
  /** 无法转换的像素留在原位置并附诊断。 */
  diagnostics: Array<{ row: number; col: number; reason: string }>;
}

export interface DecisionRecord {
  decisionId: string;
  candidateId: string;
  verdict: 'accept' | 'reject' | 'adjust';
  reason: string;
}

// ---------------------------------------------------------------------------
// 复核视图快照：页面并排展示所需的全部切片，每个显示值带稳定身份。
// ---------------------------------------------------------------------------

export interface ReviewSlice {
  wrappedPhaseRef: VersionId;
  unwrappedCandidateId: string | null;
  qualityMapRef: VersionId;
  cutNetworkRef: VersionId;
  cycleResiduals: CycleResidual[];
  heightChainId: string | null;
  locks: LocalLock[];
}

// ---------------------------------------------------------------------------
// 机器可读事件：判断依据落库，可重放。
// ---------------------------------------------------------------------------

export type DomainEvent =
  | { type: 'InputCommitted'; entityId: string; versionId: string; kind: InputKind; digest: string }
  | { type: 'InputRevised'; entityId: string; versionId: string; parentVersionId: string; kind: InputKind }
  | { type: 'LowAmplitudeNoGuess'; pixels: Array<[number, number]>; threshold: number; rule: 'low-amplitude-no-guess' }
  | { type: 'CutOffsetDeclared'; cutId: string; sideA: string; sideB: string; k: number; rule: 'explicit-cut-offset' }
  | { type: 'CandidateGenerated'; candidateId: string; treeId: string; componentId: string }
  | { type: 'CycleNonClosure'; cycleId: string; residual: Quantity; rule: 'keep-path-and-cycle-residual' }
  | { type: 'IntegerAmbiguityKept'; componentId: string; legalCandidateIds: string[]; rule: 'keep-all-legal-candidates' }
  | { type: 'TreeVariantKept'; componentId: string; treeIds: string[]; rule: 'keep-path-and-cycle-residual' }
  | { type: 'LocalLockPlaced'; lockId: string; candidateId: string; componentId: string }
  | { type: 'LocalLockConflict'; lockId: string; incomingCandidateId: string; mismatchedCuts: string[]; rule: 'local-lock-conflict' }
  | { type: 'LocalLockResolved'; lockId: string; resolution: 'keep-lock' | 'adopt-incoming'; decisionId: string }
  | { type: 'DecisionRecorded'; decisionId: string; candidateId: string; verdict: string; reason: string }
  | { type: 'UndoApplied'; undoneEventSeq: number; decisionId: string }
  | { type: 'StalenessMarked'; derivedKey: string; becauseOfVersionId: string }
  | { type: 'HeightConverted'; chainId: string; candidateId: string; wavelengthVersionId: string }
  | { type: 'UnitDiagnostic'; location: string; reason: string };

export interface StoredEvent {
  seq: number;
  eventId: string;
  at: number;
  event: DomainEvent;
}
