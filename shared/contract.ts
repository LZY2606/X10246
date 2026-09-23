/**
 * 领域数据契约：光学干涉 / 二维相位展开 / 光学标定。
 * 所有领域量都携带单位或坐标基准；原始表示在导入层保留，派生层才做规范化。
 */

// ---------- 坐标与单位 ----------
export type PhaseUnit = 'rad';
export type LengthUnit = 'nm' | 'um';
export type AngleUnit = 'deg';
export type QualityUnit = 'snr-score'; // 0..1 信噪评分
export type MaskUnit = 'bool';

export interface GridBasis {
  kind: 'sensor-grid';
  width: number;
  height: number;
  /** 像素间距（物方），nm */
  spacingNm: [number, number];
  /** 坐标原点约定 */
  origin: 'top-left';
}

/** 原始网格：导入时保留原始表示（encoding/raw），派生层另行规范化 */
export interface RawGrid {
  basis: GridBasis;
  unit: PhaseUnit | QualityUnit | MaskUnit;
  /** 原始编码声明，如 'rad-float64-rowmajor'、'u8-mask' */
  encoding: string;
  /** 行主序数据（规范化副本的源） */
  data: number[];
  /** 原始表示（导入时的原文，可为 base64/文本），永不修改 */
  raw?: string;
}

// ---------- 输入实体（基线，均不可覆盖） ----------
export interface WrappedPhaseFrame {
  kind: 'WrappedPhaseFrame'; // 原相位像素（包裹相位）
  grid: RawGrid;             // unit = rad，值域 [-π, π)
}

export interface QualityScoreMap {
  kind: 'QualityScoreMap';   // 信噪评分
  grid: RawGrid;             // unit = snr-score
  source: 'amplitude' | 'correlation' | 'external';
}

export interface InvalidMask {
  kind: 'InvalidMask';       // 无效遮罩
  grid: RawGrid;             // unit = bool（1 = 无效）
  reason: string;
}

export interface WavelengthSpec {
  kind: 'WavelengthSpec';    // 波长
  valueNm: number;
  medium: 'air' | 'vacuum';
  source: string;            // 例如 'HeNe 激光器铭牌' / '标定证书 #...'
}

export interface IncidentGeometry {
  kind: 'IncidentGeometry';  // 入射几何
  mode: 'reflection' | 'transmission';
  incidenceDeg: number;
  azimuthDeg: number;
}

export interface CalibrationSurface {
  kind: 'CalibrationSurface'; // 标定面
  reference: string;          // 标定帧来源标识
  flatnessNm: number;
  tiltRemoved: boolean;
}

export interface CutEdit {
  seq: number;
  op: 'add-cut' | 'remove-cut';
  /** 切口边（像素边缘），显式记录跨越切口时的整周跳变方向 */
  edge: { x: number; y: number; dir: 'h' | 'v' };
  kJump: 1 | -1;
  author: string;
  note?: string;
}

export interface CutEditHistory {
  kind: 'CutEditHistory';    // 切口编辑历史（只追加）
  edits: CutEdit[];
}

export type BaselineInput =
  | WrappedPhaseFrame | QualityScoreMap | InvalidMask
  | WavelengthSpec | IncidentGeometry | CalibrationSurface | CutEditHistory;

export const BASELINE_KINDS = [
  'WrappedPhaseFrame', 'QualityScoreMap', 'InvalidMask',
  'WavelengthSpec', 'IncidentGeometry', 'CalibrationSurface', 'CutEditHistory',
] as const;
export type BaselineKind = (typeof BASELINE_KINDS)[number];

// ---------- 导入包 ----------
export interface InterferogramBundle {
  format: 'interferogram-bundle/1';
  label: string;
  /** 共享原始片段：patchRef -> 内容哈希（只存一份） */
  patches?: Record<string, RawGrid>;
  frames: {
    wrappedPhase: RawGrid;
    quality: RawGrid;
    invalidMask: RawGrid;
  };
  wavelength: Omit<WavelengthSpec, 'kind'>;
  geometry: Omit<IncidentGeometry, 'kind'>;
  calibration: Omit<CalibrationSurface, 'kind'>;
  cutHistory?: CutEdit[];
  meta?: Record<string, string>;
}

// ---------- 决定实体（一等数据：候选、拒绝原因、未知状态） ----------
export interface CutEdge {
  x: number; y: number; dir: 'h' | 'v';
  /** 切口两侧的整周偏移，显式表示 */
  kJump: 1 | -1;
  origin: 'residue-pairing' | 'manual';
}

export interface BranchCutNetwork {
  kind: 'BranchCutNetwork';
  edges: CutEdge[];
  residues: { x: number; y: number; polarity: 1 | -1 }[];
}

export interface CycleResidual {
  loopId: string;
  /** 闭合环路的像素路径 */
  path: [number, number][];
  /** 环路残差（rad），非零即循环不闭合 */
  residualRad: number;
  closed: boolean;
}

export interface UnknownRegion {
  reason: 'low-amplitude' | 'invalid-mask';
  /** 低振幅区域不得猜相位：这些像素保持未知 */
  pixels: [number, number][];
}

export interface UnwrapCandidate {
  candidateId: string;
  treeId: string;            // 展开树标识（不同展开树可得到局部一致解）
  seed: [number, number];
  /** 整周数图（k-map），未知像素为 null */
  kMap: (number | null)[];
  /** 未确定绝对整周数的连通岛及其合法取值 */
  ambiguousIslands: { islandId: string; legalK: number[] }[];
  cycleResiduals: CycleResidual[];
  unknown: UnknownRegion[];
  /** 展开路径摘要（BFS 访问顺序哈希），用于复核 */
  pathDigest: string;
}

export interface UnwrapResult {
  kind: 'UnwrapResult';
  cuts: BranchCutNetwork;
  candidates: UnwrapCandidate[];
  rejected: { candidateId: string; reasons: string[] }[];
}

export interface HeightConversionChain {
  kind: 'HeightConversionChain';
  steps: [
    { stage: 'wrapped-phase'; ref: string },
    { stage: 'unwrapped-phase'; ref: string; candidateId: string },
    { stage: 'height'; wavelengthRef: string; geometryRef: string; calibrationRef: string; factorNmPerRad: number },
  ];
  /** 高度图（nm），未知像素为 null */
  heightNm: (number | null)[];
  basis: GridBasis;
}

export interface LocalLock {
  kind: 'LocalLock';
  lockId: string;
  candidateId: string;
  region: { x: number; y: number; w: number; h: number };
  kOffset: number;
  status: 'active' | 'superseded' | 'conflicted';
}

export interface Decision {
  kind: 'Decision';
  targetRef: string;         // 指向候选/锁/结果版本
  verdict: 'accept' | 'reject' | 'adjust';
  rationale: string;
  params?: Record<string, number | string>;
}

// ---------- 版本与溯源 ----------
export interface Versioned<T> {
  entityId: string;
  versionId: string;         // 内容寻址，稳定身份
  parentVersionId: string | null;
  createdSeq: number;
  content: T;
  summary: string;
}

export interface DerivedMeta {
  algorithmVersion: string;
  paramsFingerprint: string;
  /** 直接来源的版本号（精确引用，缺引用即损坏，不得退回最新版） */
  sourceRefs: string[];
  stale: boolean;
  staleReason?: string;
}

// ---------- 事件（机器可读取的判断依据） ----------
export type EventType =
  | 'baseline.imported'
  | 'input.revised'
  | 'unwrap.candidates_generated'
  | 'candidate.rejected'
  | 'lowamplitude.guess_refused'   // 低振幅区域不得猜相位
  | 'cut.offset_declared'          // 切口两侧整周偏移显式表示
  | 'cycle.residual_recorded'      // 保留路径与循环残差
  | 'wavelength.revision_impact'
  | 'lock.created'
  | 'lock.conflict'
  | 'decision.recorded'
  | 'undo.recorded'
  | 'staleness.marked'
  | 'archive.exported'
  | 'archive.imported'
  | 'casepack.loaded';

export interface DomainEvent {
  seq: number;
  eventId: string;
  type: EventType;
  at: number;                // 逻辑时钟（测试注入虚拟时间）
  payload: Record<string, unknown>;
}

// ---------- 复核视图 ----------
export interface ReviewState {
  inputs: Record<BaselineKind, Versioned<BaselineInput> | null>;
  unwrap: (Versioned<UnwrapResult> & { meta: DerivedMeta }) | null;
  height: (Versioned<HeightConversionChain> & { meta: DerivedMeta }) | null;
  locks: LocalLock[];
  decisions: Versioned<Decision>[];
  diagnostics: string[];
  asOfSeq: number | null;    // null = 当前；否则为历史重放
}
