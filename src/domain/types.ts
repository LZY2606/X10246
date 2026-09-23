/**
 * 数据契约：直接采用光学干涉 / 相位展开 / 标定领域词汇。
 *
 * 输入实体（一经提交不可覆盖，后续修订以新版本 + 父版本表达）：
 *   wrappedPhaseFrame  原相位像素（包裹相位，单位 radian）
 *   amplitudeFrame     振幅 / 强度
 *   qualityScoreFrame  信噪评分（低振幅→低质量，不得猜相位）
 *   invalidMaskFrame   无效遮罩
 *   wavelength         波长（有版本；版本变更会使高度结果过期）
 *   incidenceGeometry  入射几何
 *   calibrationSurface 标定面
 *   cutEditHistory     切口编辑历史（只追加）
 *
 * 派生实体（带算法版本、参数指纹与直接来源）：
 *   qualityMap / residueMap / regionMap / cutNetwork /
 *   unwrapTree / integerCandidates / heightChain
 *
 * 决定实体：candidateDecision / regionLock / reversal
 */
import type { TypedValue, UnitName, CoordinateBasis } from './units.ts';

export type EntityType =
  | 'wrappedPhaseFrame'
  | 'amplitudeFrame'
  | 'qualityScoreFrame'
  | 'invalidMaskFrame'
  | 'wavelength'
  | 'incidenceGeometry'
  | 'calibrationSurface'
  | 'cutEditHistory'
  | 'qualityMap'
  | 'residueMap'
  | 'regionMap'
  | 'cutNetwork'
  | 'unwrapTree'
  | 'integerCandidates'
  | 'heightChain'
  | 'candidateDecision'
  | 'regionLock'
  | 'reversal';

/** 二维栅格几何：行/列、像素节距、坐标基准。 */
export interface GridGeometry {
  rows: number;
  cols: number;
  pixelPitch: TypedValue; // 每像素物理长度
  basis: CoordinateBasis;
  origin: { r: number; c: number };
}

export type FrameKind = 'wrappedPhase' | 'amplitude' | 'qualityScore' | 'invalidMask';

/**
 * 帧由不可变瓦片组合而成。共享的原始片段只存一份内容（按 contentId 去重），
 * 组合输入（最小输入 / 组合输入）各自引用同一 contentId，解释版本独立。
 */
export interface FrameContent {
  kind: FrameKind;
  unit: UnitName;
  basis: CoordinateBasis;
  rows: number;
  cols: number;
  /** 顺序无关；同坐标只允许一个瓦片，重复引用指向同一不可变内容。 */
  placements: Array<{
    tileContentId: string;
    originR: number;
    originC: number;
  }>;
  /** 原始表示（例如来源文件中的单位串、缩放、字节序），导入时保留。 */
  rawRepresentation: {
    encoding: string;
    sourceUnitText: string;
    endianness?: string;
    scale?: number;
    offset?: number;
  };
  note?: string;
}

/** 不可变瓦片：4x4 小块（边缘可更小），NaN 表示空洞（不猜值）。 */
export interface FrameTile {
  blockR: number;
  blockC: number;
  tileRows: number;
  tileCols: number;
  values: number[]; // 行优先；NaN=缺失/被遮罩
}

export interface WavelengthContent {
  value: TypedValue; // 长度，normalized 到 meter
  /** 波长“版本”由修订事件产生；这里是不可变版本内容。 */
  label: string;
  rawRepresentation: { sourceText: string; unitText: string };
}

export interface IncidenceGeometryContent {
  /** 照明方向单位向量（对象坐标系），按原始角度给出并规范化。 */
  incidenceAngle: TypedValue; // 相对法线，normalized radian
  azimuth: TypedValue; // normalized radian
  kVector: { x: number; y: number; z: number } | null; // 规范化失败为 null
  rawRepresentation: { sourceText: string };
}

export interface CalibrationSurfaceContent {
  /** 标定面：参考高度（每像素或平面），单位/坐标基准必填。 */
  kind: 'plane' | 'per-pixel';
  plane?: {
    normal: { x: number; y: number; z: number };
    constantMeters: number;
  };
  referenceHeightContentId?: string; // per-pixel 时指向瓦片帧内容
  rawRepresentation: { sourceText: string; unitText: string };
}

export interface CutEdit {
  editId: string;
  at: string; // ISO 虚拟时间
  action: 'add-cut' | 'remove-cut' | 'place' | 'snap';
  /** 支路切口连接的两像素；整周偏移在 cutNetwork 里显式表示。 */
  a: { r: number; c: number };
  b: { r: number; c: number };
  reason: string;
  actor: 'human' | 'algorithm';
}

export interface CutEditHistoryContent {
  edits: CutEdit[];
  rawRepresentation: { sourceText?: string };
}

// ---- 派生内容 ---------------------------------------------------------------

export type QualityIssue =
  | 'OK'
  | 'LOW_AMPLITUDE'
  | 'MASKED'
  | 'LOW_SNR'
  | 'PHASE_BORDER_CROSSING'
  | 'MULTIPLY_CONNECTED'
  | 'CYCLE_NOT_CLOSED'
  | 'UNKNOWN';

export interface QualityMapContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  derivesFrom: {
    amplitudeContentId: string | null;
    qualityScoreContentId: string | null;
    maskContentId: string;
    threshold: number;
  };
  /** 每像素 [0,1]；被遮罩/低振幅为 0。 */
  scoreContentId: string; // 指向瓦片帧（qualityScore 派生）
  flags: QualityIssue[]; // 逐像素标志，长度 rows*cols（枚举或 'OK'）
  flagsContentId: string;
  diagnostics: Diagnostic[];
}

export interface Residue {
  r: number;
  c: number;
  /** +1 正残差（电荷），-1 负残差。 */
  charge: 1 | -1;
  /** 2x2 包裹梯度环绕和（turns）。 */
  windingTurns: number;
}

export interface ResidueMapContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  derivesFrom: { phaseContentId: string; maskContentId: string };
  residues: Residue[];
  diagnostics: Diagnostic[];
}

export interface RegionMapContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  derivesFrom: { maskContentId: string; qualityMapContentId: string };
  /** 每个连通区域的像素集合（多连通：多个区域 + 孔洞）。 */
  regions: Array<{
    regionId: string;
    pixels: Array<{ r: number; c: number }>;
    containsHole: boolean;
    holes: Array<{ r: number; c: number }>;
  }>;
  /** 每像素区域 id 或 null（遮罩/孔洞）。 */
  labelContentId: string;
  diagnostics: Diagnostic[];
}

export interface BranchCut {
  cutId: string;
  a: { r: number; c: number };
  b: { r: number; c: number };
  /** 切口两侧的整周偏移，显式表示（k_b - k_a，单位 turn）。 */
  integerOffsetTurns: number | null; // 未知时为 null（不得猜）
  kind: 'residue-pair' | 'residue-to-border' | 'human' | 'tree';
  residues: string[]; // 关联残差 id
}

export interface CutNetworkContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  derivesFrom: {
    residueMapEventId: string;
    regionMapEventId: string;
    cutHistoryEventId: string;
  };
  cuts: BranchCut[];
  /** 由切口造成的多连通/边界穿越诊断。 */
  diagnostics: Diagnostic[];
}

export interface UnwrapTreeContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  treeVariant: string; // 不同展开树：如 'mst-quality' / 'bfs-border'
  derivesFrom: {
    phaseContentId: string;
    cutNetworkEventId: string;
    regionMapEventId: string;
  };
  /** 路径：展开树的有向边（父→子），保留路径。 */
  edges: Array<{
    from: { r: number; c: number };
    to: { r: number; c: number };
    /** 该边沿的整周增量（turns），低振幅/遮罩边为 null。 */
    deltaTurns: number | null;
    valid: boolean;
  }>;
  root: { r: number; c: number };
  regionId: string;
  /** 循环残差：闭合环的残差（turns）；非零即“循环不闭合”。 */
  cycleResiduals: Array<{
    cycleId: string;
    vertices: Array<{ r: number; c: number }>;
    residualTurns: number;
    closed: boolean;
  }>;
  /** 展开相位结果帧（rad）；低振幅像素为 NaN。 */
  unwrappedContentId: string;
  diagnostics: Diagnostic[];
}

export interface IntegerOption {
  k: number; // 相对整周数
  legal: boolean;
  adopted: boolean;
  rejectReason: string | null;
  residualTurns: number; // 选择该 k 后的循环残差
  supportCount: number;
}

export interface IntegerCandidatesContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  derivesFrom: {
    unwrapTreeEventId: string;
    cutNetworkEventId: string;
  };
  /** 每个“歧义位置”（切口跨越 / 多树交界 / 残差点）保留全部合法候选。 */
  ambiguities: Array<{
    ambiguityId: string;
    location: { r: number; c: number };
    kind: 'across-cut' | 'tree-junction' | 'residue';
    options: IntegerOption[];
    /** 无法唯一决定：legal 选项数 > 1 且无额外约束时为 true。 */
    nonUnique: boolean;
  }>;
  diagnostics: Diagnostic[];
}

export interface HeightStep {
  index: number;
  operation: string; // 领域语义步骤名
  formula: string;
  inputs: Array<{ name: string; contentRef: string | null; unit: UnitName | 'mixed' }>;
  outputUnit: UnitName;
  /** 逐步中间量；无法计算为 null 并附诊断。 */
  values: number[] | null; // 每像素或标量
  diagnostic: string | null;
}

export interface HeightChainContent {
  algorithmVersion: string;
  parameterFingerprint: string;
  derivesFrom: {
    unwrapTreeEventId: string;
    integerCandidatesEventId: string | null;
    wavelengthEventId: string;
    geometryEventId: string;
    calibrationEventId: string;
  };
  /** 高度转换链：展开相位→光程差→物理高度（相对标定面）。 */
  steps: HeightStep[];
  heightContentId: string; // 最终高度帧（meter），NaN 未知
  heightUnit: UnitName;
  diagnostics: Diagnostic[];
}

export interface CandidateDecisionContent {
  decision: 'accept' | 'reject' | 'adjust';
  ambiguityId: string;
  chosenK: number | null;
  rejectedK: number[];
  rationale: string;
  at: string;
  /** 该决定针对的候选集合版本（直接来源）。 */
  integerCandidatesEventId: string;
  parameterAdjustment?: Record<string, number | string>;
}

export interface RegionLockContent {
  regionId: string;
  lock: 'locked' | 'unlocked';
  interpretation: string; // 锁定的局部解读
  at: string;
  /** 锁定时绑定的依赖版本（高度/候选/树事件 id）。 */
  bound: {
    heightChainEventId: string;
    unwrapTreeEventId: string;
    integerCandidatesEventId: string | null;
  };
  /** 与既有锁冲突时记录。 */
  conflictsWith: string[];
  status: 'active' | 'conflict' | 'superseded';
}

export interface ReversalContent {
  kind: 'undo' | 'rollback';
  targetEventId: string; // 撤销/回滚到哪个旧事件
  at: string;
  reason: string;
  /** 回滚后恢复的依赖版本快照。 */
  restoredRefs: Record<string, string>;
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  at?: { r: number; c: number };
  refs?: string[];
}

// ---- 事件封装 ---------------------------------------------------------------

export type EventType =
  | 'project.created'
  | 'frame.imported'
  | 'wavelength.revised'
  | 'geometry.revised'
  | 'calibration.revised'
  | 'cut.edited'
  | 'quality.computed'
  | 'residues.computed'
  | 'regions.computed'
  | 'cuts.computed'
  | 'unwrap.computed'
  | 'integers.computed'
  | 'height.computed'
  | 'candidate.decided'
  | 'region.locked'
  | 'history.reversed'
  | 'bundle.exported'
  | 'annotation.appended';

export interface EventRecord {
  eventId: string;
  projectId: string;
  seq: number;
  type: EventType;
  parentEventId: string | null;
  at: string; // 虚拟时间 ISO
  /** 该事件主体内容的内容哈希（不可变内容）。 */
  contentId: string;
  /** 该事件直接引用的版本（事件 id）。缺少引用在查询时报损坏。 */
  refs: string[];
  /** 该事件产生/更新的实体（类型 + 稳定实体键）。 */
  entity: { type: EntityType; key: string };
  /** 实体版本：修订/重算时 version+1，父版本事件 id。 */
  version: number;
  parentVersionEventId: string | null;
  actor: 'human' | 'algorithm' | 'system';
  payload: unknown; // 已落库的具体内容对象
}

export interface ContentRecord {
  contentId: string;
  kind: string;
  canonical: string;
  bytes: number;
}

export interface ProjectRecord {
  projectId: string;
  name: string;
  createdAt: string;
  scenarioTags: string[];
}
