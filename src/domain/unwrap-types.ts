import type {
  AlgorithmFingerprint,
  BranchCutSegment,
  DirectSource
} from "../shared/types";

/** 残差点电荷：+1 正残差，-1 负残差，0 非残差。 */
export interface ResidueCell {
  row: number;
  col: number;
  charge: 1 | -1;
  /** 2x2 缠绕梯度环绕和（radian） */
  wrapSum: number;
}

export interface QualityMapPayload {
  /** 每像素质量评分 0..1；无效像素为 null */
  quality: (number | null)[];
  min: number;
  max: number;
}

export interface ResidueMapPayload {
  residues: ResidueCell[];
  positiveCount: number;
  negativeCount: number;
  unpairedCharge: number;
}

export interface BranchCutNetworkPayload {
  segments: BranchCutSegment[];
  pairedDipoles: number;
  borderLeaders: number;
  blockedCells: [number, number][];
}

export interface Region {
  regionId: string;
  cells: [number, number][];
  /** 相对其他区域的整周偏移基线；由切口跨越决定。 */
  cycleOffsetBaseline: number;
  touchesBorder: boolean;
  holes: number;
}

export interface ConnectedRegionsPayload {
  regions: Region[];
  connectivity: number;
  multiplyConnected: boolean;
}

/** 展开树节点（像素）；parent=null 为种子。 */
export interface UnwrappingTreeNode {
  row: number;
  col: number;
  parent: [number, number] | null;
  /** 到父节点的缠绕跳变（radian） */
  edgeWrap: number;
  /** 该点整周数 k：unwrapped = wrapped + 2πk */
  cycles: number;
  depth: number;
}

export interface UnwrappingTreePayload {
  treeId: string;
  regionId: string;
  seed: [number, number];
  nodes: UnwrappingTreeNode[];
  /** 树路径描述（审计用，稳定顺序） */
  pathTrace: { from: [number, number]; to: [number, number]; wrap: number }[];
  /** 被该树跨过/回避的切口 */
  cutsRespected: string[];
}

export interface IntegerCycleCandidate {
  candidateId: string;
  cell: [number, number];
  /** 合法整周数 k 的全部取值；多解时长度 > 1 */
  possibleK: number[];
  chosenK: number | null;
  status: "legal" | "accepted" | "rejected";
  rejectionReason?: string;
  /** 支持该候选的树路径 id */
  supportingTreePaths: string[];
}

export interface IntegerCycleCandidateSetPayload {
  candidates: IntegerCycleCandidate[];
  ambiguousCellCount: number;
}

export interface UnwrappedPhaseFieldPayload {
  /** 展开相位 radian；低振幅/无效像素保持 null，绝不猜值 */
  unwrapped: (number | null)[];
  /** 每像素整周数；无法唯一决定时为 null */
  cycles: (number | null)[];
  heldCells: [number, number][];
  /** 切口两侧的显式整周偏移 */
  cutOffsets: {
    segmentId: string;
    sideACell: [number, number];
    sideBCell: [number, number];
    cycleDelta: number | null;
    phaseDeltaRadian: number | null;
    explicit: boolean;
  }[];
}

export interface LoopResidual {
  loopId: string;
  cells: [number, number][];
  /** 缠绕增量闭合和（radian），非零时必须是 2π 的整数倍才允许补整周 */
  wrappedClosureRadian: number;
  /** 补整周后仍残留的不闭合量（radian），0 为闭合 */
  residualRadian: number;
  cycleClosure: number | null;
  closed: boolean;
  quality: number;
}

export interface LoopResidualSetPayload {
  loops: LoopResidual[];
  openLoopCount: number;
}

export interface HeightStep {
  stepId: string;
  operation: string;
  formula: string;
  inputs: Record<string, string>;
  outputUnit: string;
  wavelengthVersionUsed: string;
}

export interface HeightConversionChainPayload {
  steps: HeightStep[];
  /** 表面高度（米）；不可转换处为 null 并附诊断 */
  heightMeters: (number | null)[];
  calibrationApplied: boolean;
  diagnostics: { index: number; code: string; message: string }[];
}

export interface PipelineResultBundle {
  quality: QualityMapPayload;
  residues: ResidueMapPayload;
  cuts: BranchCutNetworkPayload;
  regions: ConnectedRegionsPayload;
  trees: UnwrappingTreePayload[];
  cycles: IntegerCycleCandidateSetPayload;
  unwrapped: UnwrappedPhaseFieldPayload;
  loops: LoopResidualSetPayload;
  heights: HeightConversionChainPayload;
  fingerprint: AlgorithmFingerprint;
  directSources: DirectSource;
}
