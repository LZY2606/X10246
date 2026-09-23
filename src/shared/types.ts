/**
 * 数据契约：直接使用光学干涉/相位展开/标定领域词汇。
 * 输入实体一经提交不可覆盖；修订以新版本 + 父版本关系表达。
 */
import type { CoordinateDatum, ConversionDiagnostic, Quantity, LengthUnit, AngleUnit } from "./units.js";

export const INPUT_KINDS = [
  "wrapped-phase",      // 原相位像素（包裹相位，rad，(-π,π]）
  "quality-map",        // 信噪评分（由振幅/信噪比得到的质量图，[0,1]）
  "invalid-mask",       // 无效遮罩
  "wavelength",         // 波长
  "incident-geometry",  // 入射几何
  "calibration-plane",  // 标定面
  "cut-edit-history",   // 切口编辑历史
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export interface Grid {
  width: number;
  height: number;
  /** 行主序；无效/未知位置在遮罩中表达，网格本身保留原始数值 */
  data: number[];
}

export interface WrappedPhaseContent {
  kind: "wrapped-phase";
  phase: Grid;
  unit: "rad";
  datum: CoordinateDatum;
}

export interface QualityMapContent {
  kind: "quality-map";
  quality: Grid;
  unit: "1";
  datum: CoordinateDatum;
  /** 原始振幅表示（导入层保留，派生层才归一化） */
  rawAmplitude?: Grid;
  amplitudeUnit?: string;
}

export interface InvalidMaskContent {
  kind: "invalid-mask";
  mask: Grid; // 1 = 无效，0 = 有效
  datum: CoordinateDatum;
}

export interface WavelengthContent {
  kind: "wavelength";
  wavelength: Quantity<LengthUnit>;
  source: string; // 光源标识，例如 "HeNe-laser-01"
}

export interface IncidentGeometryContent {
  kind: "incident-geometry";
  incidenceAngle: Quantity<AngleUnit>;
  azimuth: Quantity<AngleUnit>;
  datum: CoordinateDatum;
}

export interface CalibrationPlaneContent {
  kind: "calibration-plane";
  /** h(x,y) = a*x + b*y + c，单位 nm，坐标基准见 datum */
  coefficients: { a: number; b: number; c: number; unit: LengthUnit };
  datum: CoordinateDatum;
}

export interface CutEdit {
  op: "add-cut" | "remove-cut";
  /** 切口经过的像素边（两端像素坐标） */
  between: [[number, number], [number, number]];
  reason: string;
}

export interface CutEditHistoryContent {
  kind: "cut-edit-history";
  edits: CutEdit[];
}

export type InputContent =
  | WrappedPhaseContent
  | QualityMapContent
  | InvalidMaskContent
  | WavelengthContent
  | IncidentGeometryContent
  | CalibrationPlaneContent
  | CutEditHistoryContent;

/** 不可变输入版本 */
export interface InputVersion {
  id: string;          // 稳定身份：内容寻址哈希
  kind: InputKind;
  version: number;     // 同一 lineage 内的版本号
  lineageId: string;   // 同一实体的修订链
  parentId: string | null;
  contentHash: string;
  content: InputContent;
  /** 共享原始片段引用：fragment:<hash>，片段只存一份 */
  fragmentRefs: string[];
  source: string;      // 导入来源（案例包 / 粘贴导入 / 修订）
  createdAt: number;
}

/** 展开候选：候选、拒绝原因、误差、未知状态都是一等数据 */
export interface UnwrapCandidate {
  id: string;
  algoVersion: string;          // 例如 "quality-guided-branch-cut@1"
  paramFingerprint: string;     // 参数指纹（阈值、种子等哈希）
  params: UnwrapParams;
  inputRefs: InputRef[];        // 直接来源（含版本号）
  tree: UnwrapTree;
  cutOffsets: CutOffset[];      // 切口两侧整周偏移，显式表示
  cycleResiduals: CycleResidual[];
  unknownPixels: UnknownPixel[]; // 低振幅区域：不得猜相位
  diagnostics: ConversionDiagnostic[];
  status: CandidateStatus;
  adjudication: Adjudication | null;
  createdAt: number;
}

export interface UnwrapParams {
  lowAmplitudeThreshold: number;
  seedPixel: [number, number];
  treeLabel: string; // 展开树标识，例如 "tree-A" / "tree-B"
}

export interface InputRef {
  kind: InputKind;
  id: string;
  version: number;
  contentHash: string;
}

export type CandidateStatus = "current" | "stale" | "rejected" | "accepted";

export interface UnwrapTree {
  label: string;
  seedPixel: [number, number];
  /** 展开相位网格（rad）；低振幅/无效位置为 null */
  unwrapped: (number | null)[];
  /** 整周数 k 图：unwrapped = wrapped + 2πk */
  kMap: (number | null)[];
  /** 路径：每个像素的父像素（BFS 树），种子为 null */
  parents: ([number, number] | null)[];
  width: number;
  height: number;
}

/** 切口两侧的整周偏移：显式的未知整数变量与其合法候选 */
export interface CutOffset {
  id: string;
  between: [[number, number], [number, number]];
  componentA: number;
  componentB: number;
  /** 已求解时为整数；无法唯一决定时为 null 且 candidates 保留全部合法值 */
  deltaK: number | null;
  candidates: number[];
  rationale: string;
}

export interface CycleResidual {
  cell: [number, number];
  /** 环路残差（单位：整周），非零即循环不闭合 */
  residualTurns: number;
  path: [number, number][];
}

export interface UnknownPixel {
  at: [number, number];
  reason: "low-amplitude" | "masked";
  quality: number | null;
}

export interface Adjudication {
  verdict: "accepted" | "rejected";
  rationale: string;
  decidedAt: number;
}

/** 局部锁定：允许锁定局部解；冲突作为一等事件 */
export interface LocalLock {
  id: string;
  region: { r0: number; c0: number; r1: number; c1: number };
  candidateId: string;
  status: "active" | "conflicted" | "resolved" | "reverted";
  createdAt: number;
}

/** 高度转换链：相位 → 整周修正 → 波长/几何 → 标定面差 */
export interface HeightChain {
  candidateId: string;
  wavelengthRef: InputRef;
  geometryRef: InputRef;
  calibrationRef: InputRef;
  heights: (number | null)[]; // nm
  unit: "nm";
  datum: CoordinateDatum;
  diagnostics: ConversionDiagnostic[];
}

export type DomainEventType =
  | "input.imported"
  | "input.revised"
  | "candidate.generated"
  | "candidate.staled"
  | "low-amplitude.unknown-declared"
  | "cut.offsets-declared"
  | "tree.divergence-kept"
  | "cycle.nonclosure-detected"
  | "wavelength.version-changed"
  | "integer.ambiguity-kept"
  | "lock.acquired"
  | "lock.conflict-detected"
  | "lock.resolved"
  | "decision.recorded"
  | "decision.reverted"
  | "export.created"
  | "import.completed";

export interface DomainEvent {
  seq: number;
  id: string;
  type: DomainEventType;
  /** 机器可读取的判断依据 */
  payload: Record<string, unknown>;
  at: number;
}
