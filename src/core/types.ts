// 干涉条纹簿 —— 领域数据契约
// 词汇直接来自光学干涉测量：包裹相位、振幅、信噪评分、遮罩、波长、入射几何、标定面、
// 残差点、支路切口（branch cut）、多连通区、展开树、循环残差、整周候选、表面高度。

/** 角度单位，包裹相位固定为弧度，范围按 convention 判定 */
export type AngleUnit = "rad";

/** 坐标基准：网格索引 / 标定面物理坐标 / 波长比例坐标 */
export type CoordinateBasis = "pixel-index" | "calibration-plane" | "wavelength-normalized";

export interface UnitTag {
  /** 单位符号，如 rad、nm、um、mm、deg、px、nm-per-fringe */
  unit: string;
  basis: CoordinateBasis;
}

/** 二维规则网格载体；所有数组按行主序存储，长度 = rows*cols */
export interface PhaseGrid {
  rows: number;
  cols: number;
  /** 包裹相位，rad，约定主值范围 [-pi, pi) */
  wrappedPhase: number[];
  /** 振幅（调制强度），无量纲相对量；低振幅区域禁止猜相位 */
  amplitude: number[];
  /** 信噪评分 [0,1]，由导入层给出或从振幅派生并记录算法版本 */
  snr: number[];
  /** 无效遮罩：true = 无效（遮挡、低振幅孔洞、越界），永不参与展开 */
  invalidMask: boolean[];
  /** 像素物理尺寸（标定后），可为空表示仅像素坐标 */
  pixelPitch?: { x: number; y: number; unit: string };
  /** 原始表示保留：导入时给出的单位/进制等，无法转换的值留在原位置 */
  origin: {
    sourceName: string;
    phaseRepresentation: string;
    amplitudeRepresentation: string;
    /** 逐像素的无法转换诊断；键为行主序索引 */
    unconverted?: Record<number, ConversionDiagnostic>;
  };
}

export interface ConversionDiagnostic {
  field: "wrappedPhase" | "amplitude" | "snr";
  rawValue: unknown;
  reason: string;
  /** 无法转换时该像素是否被标为无效 */
  markedInvalid: boolean;
}

/** 波长实体；版本化（波长版本变更会令高度链整体派生新版本） */
export interface Wavelength {
  wavelengthId: string;
  /** 标量波长 */
  lambda: number;
  unit: string;
  refractiveIndex: number;
  /** 光路倍增系数：离面干涉常用 4pi（往返），像面干涉常用 2pi */
  phaseFactor: "2pi" | "4pi";
  version: number;
  parentVersion?: number;
  revisionNote: string;
}

/** 入射几何：照明方向与观察方向，角度基准必须显式 */
export interface IlluminationGeometry {
  geometryId: string;
  /** 照明极角（与表面法线夹角），单位度 */
  illuminationPolarAngleDeg: number;
  /** 观察极角；法向观察 = 0 */
  observationPolarAngleDeg: number;
  /** 方位角差，度；对称光路常用 0 */
  azimuthDifferenceDeg: number;
  /** 灵敏度矢量约定，派生层使用，原始层只存角度 */
  convention: "dual-illumination-sensitivity" | "normal-observation-reflection";
  version: number;
  parentVersion?: number;
}

/** 标定面：拟合平面 ax+by+c = z（物理坐标），外加参考帧残差 */
export interface CalibrationPlane {
  calibrationId: string;
  plane: { a: number; b: number; c: number };
  coordinateUnit: string;
  basis: CoordinateBasis;
  fitRms: number;
  referencePoints: Array<{ row: number; col: number; x: number; y: number; z: number }>;
  version: number;
  parentVersion?: number;
}

/** 支路切口编辑：在网格邻边（水平/竖直）上放置/移除切口；历史不可覆盖 */
export type CutEdgeKind = "horizontal" | "vertical";

export interface CutEdit {
  editId: string;
  kind: CutEdgeKind;
  row: number;
  col: number;
  action: "place" | "remove";
  origin: "auto-pairing" | "manual";
  reason: string;
  seq: number;
}

/** 残差点电荷：2x2 元胞的包裹梯度环绕和归一到 {-1,0,+1} */
export type ResidueCharge = -1 | 0 | 1;

export interface ResidueMap {
  charges: ResidueCharge[];
  positiveCount: number;
  negativeCount: number;
  algorithmVersion: string;
}

/** 质量图：由振幅+SNR 派生，另有独立的不可信标记（低振幅孔洞不猜相位） */
export interface QualityMap {
  quality: number[];
  doNotGuess: boolean[];
  amplitudeThreshold: number;
  snrThreshold: number;
  algorithmVersion: string;
}

/** 切口网络：被禁止穿越的邻边集合 */
export interface CutNetwork {
  cutEdges: string[];
  pairings: Array<{
    pairingId: string;
    edgeKeys: string[];
    from: { type: "residue"; row: number; col: number } | { type: "border" };
    to: { type: "residue"; row: number; col: number } | { type: "border" };
    length: number;
    source: "auto-pairing" | "manual";
  }>;
  algorithmVersion: string;
}

/** 多连通区：去掉切口/无效单元后的连通分量 */
export interface RegionMap {
  regionOfPixel: number[];
  regionCount: number;
  regionSizes: number[];
}

/** 展开树：区域内一棵生成树；不同树得到局部一致解但跨切口整数偏移可能不同 */
export interface UnwrapTree {
  treeId: string;
  regionId: number;
  strategy: "bfs-flood" | "dfs-flood";
  edges: Array<{ from: number; to: number; wrappedStep: number; order: number }>;
  unwrappedPhase: number[];
  anchorPixel: number;
}

/** 循环残差：沿闭合路径累加包裹梯度与直接边的差，非零即循环不闭合 */
export interface CycleResidual {
  cycleId: string;
  kind: "plaquette" | "region-adjacency";
  pixelCycle: number[];
  wrapResidualTurns: number;
  rawResidualRad: number;
  residuePlaquette?: { row: number; col: number; charge: ResidueCharge };
  closed: boolean;
}

/** 整周候选：切口两侧区域间的整数（fringe）偏移；无法唯一决定时保留全部合法候选 */
export interface IntegerCandidate {
  candidateId: string;
  acrossEdge: { kind: CutEdgeKind; row: number; col: number };
  regionA: number;
  regionB: number;
  integerTurns: number;
  mismatchRad: number;
  support: number;
  rejected: boolean;
  rejectReason?: string;
  conflictsWithLocks: string[];
}

/** 人工锁定：审阅者对某切口两侧整周偏移的局部裁定 */
export interface LocalLock {
  lockId: string;
  acrossEdge: { kind: CutEdgeKind; row: number; col: number };
  regionA: number;
  regionB: number;
  lockedIntegerTurns: number;
  decidedBy: string;
  decidedAtVirtual: number;
  status: "active" | "undone";
  undoneByEvent?: string;
  note: string;
}

/** 高度转换链：展开相位 ->（几何灵敏度/波长）-> 相对高度 ->（标定面）-> 表面高度 */
export interface HeightChain {
  chainId: string;
  wavelengthVersion: number;
  geometryVersion: number;
  calibrationVersion: number;
  sensitivityPerUnit: number;
  sensitivityUnit: string;
  relativeHeight: number[];
  calibrationDatum: number[];
  surfaceHeight: Array<number | null>;
  heightUnit: string;
  algorithmVersion: string;
  parameterFingerprint: string;
}

export type ResultStaleness = "current" | "stale" | "corrupt";

export interface DerivationRef {
  kind:
    | "phase-grid"
    | "wavelength"
    | "geometry"
    | "calibration"
    | "cut-history"
    | "residue-map"
    | "quality-map"
    | "cut-network"
    | "region-map"
    | "unwrap-tree"
    | "cycle-residual"
    | "integer-candidate"
    | "local-lock"
    | "height-chain";
  id: string;
  version: number;
  contentDigest: string;
}

export interface ParameterFingerprint {
  algorithmVersion: string;
  params: Record<string, unknown>;
  fingerprint: string;
}

export interface AnalysisRun {
  runId: string;
  seq: number;
  derivedAtVirtual: number;
  directSources: DerivationRef[];
  parameter: ParameterFingerprint;
  residueMap?: ResidueMap;
  qualityMap: QualityMap;
  cutNetwork: CutNetwork;
  regionMap: RegionMap;
  trees: UnwrapTree[];
  cycles: CycleResidual[];
  candidates: IntegerCandidate[];
  heightChains: HeightChain[];
}

export type EventType =
  | "project-created"
  | "inputs-committed"
  | "parameters-revised"
  | "source-revised"
  | "analysis-derived"
  | "candidate-decided"
  | "local-lock-applied"
  | "local-lock-conflict"
  | "lock-undone"
  | "archive-verdict-recorded"
  | "project-exported";

export interface ProjectEvent {
  eventId: string;
  seq: number;
  type: EventType;
  atVirtual: number;
  actor: string;
  payload: unknown;
  hash: string;
  prevHash: string;
}

export interface EntityManifest {
  ref: DerivationRef;
  stale: ResultStaleness;
  summary: string;
  inbound: DerivationRef[];
  outbound: DerivationRef[];
  corruption?: string;
}

export interface CounterexampleArchive {
  archiveId: string;
  scenario: CounterexampleScenario;
  baselineDigest: string;
  mutatedSource: DerivationRef;
  baselineSources: DerivationRef[];
  verdicts: ArchiveVerdict[];
  accepted: Array<{ runId: string; candidateId?: string; note: string }>;
  rejected: Array<{ runId: string; candidateId?: string; reason: string }>;
}

export type CounterexampleScenario =
  | "phase-wrap-boundary"
  | "low-amplitude-hole"
  | "multiply-connected-region"
  | "cycle-nonclosure"
  | "wavelength-version-change"
  | "integer-ambiguity"
  | "local-lock-conflict";

export interface ArchiveVerdict {
  verdictId: string;
  atVirtual: number;
  rule:
    | "no-guessing-in-low-amplitude"
    | "explicit-integer-across-cuts"
    | "tree-path-and-cycle-residual-kept";
  machineReadable: {
    predicate: string;
    object: DerivationRef;
    expected: unknown;
    actual: unknown;
    passed: boolean;
  };
  adopted: boolean;
  evidenceRefs: DerivationRef[];
}
