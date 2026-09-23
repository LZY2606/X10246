/**
 * 分析层输出类型：候选、拒绝原因、误差/未知都是一等数据。
 * 身份规则：所有身份由 (版本化内容 + 稳定坐标) 决定，导出再导入保持不变。
 */
import type { LengthUnit, PixelBasis } from './vocabulary.ts';

export interface AlgorithmRef {
  name: string;
  version: string;
  parameterFingerprint: string;
}

export interface AnalysisParams {
  noiseFloorAdu: number;
  lowAmplitudeThresholdAdu: number;
  snrDecayPerPixel: number;
  qualityRejectSnrDb: number;
  maxPlausibleJumpRad: number;
}

export const DEFAULT_PARAMS: AnalysisParams = {
  noiseFloorAdu: 12,
  lowAmplitudeThresholdAdu: 12,
  snrDecayPerPixel: 0.4,
  qualityRejectSnrDb: 8,
  maxPlausibleJumpRad: 1.9 * Math.PI,
};

export type CellQuality = 'usable' | 'low-amplitude' | 'masked' | 'uncovered';

export interface QualityField {
  snrDb: Float64Array;
  quality: CellQuality[];
  reasons: (string | null)[];
  algorithm: AlgorithmRef;
}

export interface Plaquette {
  plaquetteId: string;
  index: number;
  r: number;
  c: number;
  pixels: [number, number, number, number];
  wrappedSumRad: number;
  residueCycles: -1 | 0 | 1;
  valid: boolean;
  invalidReason: string | null;
}

export type EdgeStatus =
  | 'tree'
  | 'alt-tree'
  | 'cut-candidate'
  | 'branch-cut-required'
  | 'component-gap'
  | 'discarded';

export interface GraphEdge {
  edgeId: string;
  a: number;
  b: number;
  orientation: 'h' | 'v';
  r: number;
  c: number;
  wrappedDeltaRad: number;
  quality: number;
  status: EdgeStatus;
  /** 树边采用的整周数 k（Δunwrapped = wrappedDelta + 2πk）。 */
  treeK: number;
  /** 切口/非树边的全部合法整周候选；被拒绝候选也保留原因。 */
  candidates: IntegerCandidate[];
  /** 该边对应基本循环的残差（像元循环），单位 cycle。 */
  cycle: CycleRef | null;
  rejectedReason: string | null;
}

export interface IntegerCandidate {
  candidateId: string;
  k: number;
  deltaRad: number;
  cycleResidualCycles: number;
  fitScore: number;
  status: 'legal' | 'adopted' | 'rejected';
  rejectReason: string | null;
}

export interface CycleRef {
  cycleId: string;
  edgePath: string[];
  wrappedSumRad: number;
  residualCycles: -1 | 0 | 1;
  closed: boolean;
  note: string;
}

export interface UnwrappedTree {
  treeId: string;
  role: 'quality-guided' | 'alt-closure' | 'component-anchor';
  componentId: string;
  edges: string[];
  /** 每像素相对分量锚点的整周数；未知像素为 null。 */
  cyclesOffset: (number | null)[];
  unwrappedRad: (number | null)[];
  locallyConsistent: boolean;
  /** 该树闭合的循环与未闭合循环。 */
  closedCycles: string[];
  openCycles: string[];
  note: string;
}

export interface Component {
  componentId: string;
  pixels: number[];
  anchorPixel: number;
  /** 与其它分量之间相对 2π 偏移不可观测时，候选整周集合保留。 */
  relativeOffsetCandidates: { candidateId: string; k: number; status: 'legal' | 'adopted' | 'rejected'; reason: string | null }[];
}

export interface UnwrapResult {
  resultId: string;
  plaquettes: Plaquette[];
  edges: GraphEdge[];
  components: Component[];
  trees: UnwrappedTree[];
  /** 采纳树给出的主展开场；未知保持 null（不猜）。 */
  primaryUnwrappedRad: (number | null)[];
  /** 覆盖全部非树边的基本循环。 */
  cycles: CycleRef[];
  branchCuts: string[];
  algorithm: AlgorithmRef;
  diagnostics: string[];
}

export interface HeightStep {
  stepId: string;
  stage:
    | 'wrap-to-unwrap'
    | 'unwrapped-to-OPD'
    | 'OPD-to-geometric'
    | 'sensitivity-normal-incidence'
    | 'subtract-calibration';
  formula: string;
  inputUnit: string;
  outputUnit: string;
  wavelengthVersion: string;
  values: (number | null)[];
  note: string;
}

export interface HeightResult {
  heightId: string;
  result: UnwrapResult;
  wavelengthValueNm: number;
  wavelengthVersion: string;
  incidenceDeg: number;
  sensitivityUmPerCycle: number;
  basis: PixelBasis;
  heightUnit: LengthUnit;
  steps: HeightStep[];
  surfaceUm: (number | null)[];
  calibratedUm: (number | null)[];
  algorithm: AlgorithmRef;
}
