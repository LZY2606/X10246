/**
 * 干涉条纹簿 领域数据契约
 * ------------------------------------------------------------------
 * 全部领域量携带单位或坐标基准；原始输入保留原始表示，
 * 派生层才做规范化。无法转换的值留在原位置并附诊断。
 *
 * 这里不使用通用的 name/value 压缩表示，而是直接采用光学干涉 /
 * 相位展开 / 标定领域自己的词汇。
 */

/** 角度单位（包裹相位原始表示可使用弧度或角度） */
export type AngleUnit = 'rad' | 'deg';
/** 长度单位 */
export type LengthUnit = 'nm' | 'um' | 'mm' | 'm';
/** 几何构型 */
export type GeometryKind = 'out_of_plane' | 'in_plane' | 'twyman_green';

/** 带单位与坐标基准的标量 */
export interface UnitValue<V = number> {
  value: V;
  unit: string;
}

/** 二维网格坐标基准（像素 → 物理坐标） */
export interface GridBasis {
  rows: number;
  cols: number;
  /** 像素中心物理坐标基准 */
  origin: { x: number; y: number };
  pixelPitch: UnitValue<number>;
  /** 行优先数组长度恒等于 rows*cols */
  rowMajor: true;
}

/** 不可覆盖的原始相位像素（包裹相位） */
export interface WrappedPhasePixels {
  kind: 'wrappedPhasePixels';
  basis: GridBasis;
  /** 逐像素的包裹相位，保留原始表示（数字数组 + 原始单位） */
  values: number[];
  unit: AngleUnit;
  /** 规范化范围，例如弧度 [-Math.PI, Math.PI) */
  wrapRange: { min: number; max: number; unit: AngleUnit };
}

/** 振幅（复数干涉场的模，单位由采集设备决定，保留原值） */
export interface AmplitudeFrame {
  kind: 'amplitudeFrame';
  basis: GridBasis;
  values: number[];
  unit: 'adu' | 'counts' | 'a.u.';
}

/** 信噪评分，[0,1] 越高越可信 */
export interface SnrScore {
  kind: 'snrScore';
  basis: GridBasis;
  values: number[];
  unit: 'ratio';
}

/** 无效遮罩：true=该像素无效（低振幅/饱和/遮挡），不得猜相位 */
export interface InvalidMask {
  kind: 'invalidMask';
  basis: GridBasis;
  values: boolean[];
}

/** 波长版本（波长可修订，必须以新版本 + 父版本关系表达） */
export interface Wavelength {
  kind: 'wavelength';
  nominal: UnitValue<number>;
  /** 介质折射率（默认空气 1.0），影响等效波长 */
  refractiveIndex: number;
  /** 标定不确定度 */
  uncertainty?: UnitValue<number>;
}

/** 入射几何：照明角/观察角，均带角度单位与坐标基准 */
export interface IlluminationGeometry {
  kind: 'illuminationGeometry';
  geometry: GeometryKind;
  /** 照明方向与表面法线夹角 */
  illuminationAngle: UnitValue<number> & { unit: AngleUnit };
  /** 观察方向与表面法线夹角（Twyman-Green 通常为 0） */
  observationAngle: UnitValue<number> & { unit: AngleUnit };
  /** 角度参考平面（坐标基准） */
  referenceAxis: 'surface_normal';
}

/** 标定面：已知高度的平面参考（拟合 a*x+b*y+c，物理坐标） */
export interface CalibrationPlane {
  kind: 'calibrationPlane';
  /** 平面方程 z = a*x + b*y + c，系数带显式单位组合 */
  coefficients: { a: number; b: number; c: number };
  lengthUnit: LengthUnit;
  /** 用于拟合的标定帧像素坐标（r,c）与测得高度 */
  fiducials: Array<{ r: number; c: number; height: UnitValue<number> }>;
  /** 平面拟合残差（RMS，长度单位） */
  fitRms: UnitValue<number>;
}

/** 切口编辑历史中的单次人工编辑（不可覆盖） */
export interface CutEdit {
  editId: string;
  at: string;
  action: 'add_cut' | 'remove_cut' | 'force_join' | 'force_separate';
  edge: PixelEdge;
  reason: string;
  /** 撤销/冲突解决时指向上一条编辑 */
  supersedesEditId?: string;
}

/** 相邻像素之间的边（4 邻域） */
export interface PixelEdge {
  a: PixelIndex;
  b: PixelIndex;
}
export interface PixelIndex {
  r: number;
  c: number;
}

export interface CutEditHistory {
  kind: 'cutEditHistory';
  edits: CutEdit[];
}

/**
 * 输入实体：原始输入一经提交不可覆盖。
 * 七种受保护原始实体构成复查基线。
 */
export type InputEntityKind =
  | 'wrappedPhasePixels'
  | 'snrScore'
  | 'invalidMask'
  | 'wavelength'
  | 'illuminationGeometry'
  | 'calibrationPlane'
  | 'cutEditHistory';

export type InputEntity =
  | WrappedPhasePixels
  | SnrScore
  | InvalidMask
  | Wavelength
  | IlluminationGeometry
  | CalibrationPlane
  | CutEditHistory;

/** 反例情形（七种检验） */
export type AdversarialCase =
  | 'phase_wrap_boundary'
  | 'low_amplitude_hole'
  | 'multiply_connected_region'
  | 'cycle_misclosure'
  | 'wavelength_version_change'
  | 'integer_2pi_ambiguity'
  | 'local_lock_conflict';

/** 单个实体引用：查询时必须能解析到具体版本，缺失即损坏 */
export interface VersionRef {
  kind: InputEntityKind | DerivedKind;
  /** 稳定身份（内容派生 + 项目内序列） */
  id: string;
  /** 不可变版本号；禁止隐式回退到最新版 */
  version: number;
  /** 内容摘要（SHA-256 前缀，hex） */
  digest: string;
}

/** 派生层实体类别 */
export type DerivedKind =
  | 'qualityMap'
  | 'residueMap'
  | 'cutNetwork'
  | 'connectedComponents'
  | 'unwrappedSurface'
  | 'cycleResiduals'
  | 'integerOffsetCandidates'
  | 'heightField';

/** 相位残差点（2π 电荷） */
export interface Residue {
  r: number;
  c: number;
  /** +1 正残差，-1 负残差 */
  charge: 1 | -1;
  /** 围绕该点 2x2 闭合环的卷绕和 / 2π */
  loopSum2pi: number;
}

/** 支路切口网络中的一条边 */
export interface CutEdge extends PixelEdge {
  cutId: string;
  /** 人工编辑还是算法生成 */
  origin: 'algorithm' | 'human';
  /** 连接的残差点对（若有） */
  pairsResidues?: Array<{ r: number; c: number }>;
}

/** 多连通分量 */
export interface ConnectedComponent {
  componentId: string;
  pixels: PixelIndex[];
  /** 该分量是否含孔洞（被无效像素/切口包围的内边界） */
  hasHole: boolean;
  /** 拓扑：孔洞个数（决定独立整周自由度） */
  genus: number;
}

/** 展开树路径上的一步 */
export interface TreePathStep {
  from: PixelIndex;
  to: PixelIndex;
  /** 跨越的卷绕差（已 wrap 到主值） */
  wrappedDelta: number;
  unit: AngleUnit;
  /** 是否穿过切口（穿过则该边携带显式整周偏移） */
  crossesCut: boolean;
  /** 穿过的切口 id（若有） */
  cutId?: string;
}

/** 一棵展开树给出的局部一致解 */
export interface UnwrapTreeSolution {
  solutionId: string;
  treeTag: string;
  /** 树根 */
  root: PixelIndex;
  /** 逐像素连续相位（弧度，规范化派生表示） */
  phase: number[];
  /** 采用的路径（树边序列） */
  path: TreePathStep[];
  /** 非树边闭合环残差 */
  cycleResiduals: CycleResidual[];
  /** 切口两侧的显式整周偏移候选 */
  cutOffsets: CutOffset[];
  /** 算法版本与参数指纹 */
  algorithm: AlgorithmProvenance;
  /** 直接来源版本引用 */
  sources: VersionRef[];
  status: SolutionStatus;
  /** 局部输入变化后可能过期 */
  stale: boolean;
}

export type SolutionStatus =
  | 'unique'
  | 'multiple_valid_candidates'
  | 'unknown_low_amplitude'
  | 'cycle_conflict'
  | 'stale_view_only';

/** 非树边闭合环的循环残差 */
export interface CycleResidual {
  cycleId: string;
  edges: PixelEdge[];
  /** 闭合环卷绕和（弧度）；理想为 0 或 2π 的整数倍 */
  closure: number;
  unit: AngleUnit;
  /** closure / 2π —— 非整数即循环不闭合 */
  winding: number;
  /** 是否整数闭合 */
  closed: boolean;
  /** 包围的孔洞/分量 id（若适用） */
  encloses?: string;
}

/** 切口两侧的显式整周偏移 k：φ_unwrapped = φ_wrapped + 2π·k */
export interface CutOffset {
  cutId: string;
  edge: PixelEdge;
  /** 全部合法整周候选（无法唯一决定时保留所有候选） */
  candidates: IntegerCandidate[];
  /** 被采纳候选的 candidateId（可空） */
  acceptedCandidateId?: string;
}

export interface IntegerCandidate {
  candidateId: string;
  k: number;
  /** 采纳/拒绝的依据 */
  plausibility: number;
  decision?: 'accepted' | 'rejected' | 'undecided';
  rejectReason?: string;
}

/** 相位→高度转换链中的一步（可逐步重放） */
export interface HeightChainStep {
  stepId: string;
  operator: string;
  /** 输入值摘要 */
  inputSummary: string;
  /** 输出值摘要 */
  outputSummary: string;
  /** 该步使用的常量及其单位（如 λ、几何灵敏度因子） */
  constants: Record<string, string>;
}

/** 表面高度场（最终物理量） */
export interface HeightField {
  kind: 'heightField';
  basis: GridBasis;
  values: number[];
  unit: LengthUnit;
  /** 逐像素高度状态：ok / unknown（低振幅不猜） / stale */
  pixelStatus: Array<'ok' | 'unknown' | 'stale'>;
  /** 高度转换链（可逐步重放） */
  chain: HeightChainStep[];
  sources: VersionRef[];
  algorithm: AlgorithmProvenance;
}

/** 派生值来源出处 */
export interface AlgorithmProvenance {
  algorithm: string;
  algorithmVersion: string;
  /** 参数指纹（规范化参数 JSON 的哈希前缀） */
  parameterFingerprint: string;
  parameters: Record<string, unknown>;
}

/** 质量图（派生） */
export interface QualityMap {
  kind: 'qualityMap';
  basis: GridBasis;
  /** 0..1，越高越适合作为展开种子/路径 */
  values: number[];
  algorithm: AlgorithmProvenance;
  sources: VersionRef[];
}

/** 残差图（派生） */
export interface ResidueMap {
  kind: 'residueMap';
  basis: GridBasis;
  residues: Residue[];
  algorithm: AlgorithmProvenance;
  sources: VersionRef[];
}

/** 切口网络（派生 + 人工编辑历史） */
export interface CutNetwork {
  kind: 'cutNetwork';
  cuts: CutEdge[];
  sources: VersionRef[];
  algorithm: AlgorithmProvenance;
}

/** 人工锁定的局部解读 */
export interface LocalLock {
  lockId: string;
  pixel: PixelIndex;
  /** 锁定时的连续相位（弧度）与整周 k */
  phaseRad: number;
  k2pi: number;
  /** 锁定时引用的解版本 */
  solutionRef: VersionRef;
  at: string;
  active: boolean;
  /** 与其它锁定冲突时的诊断 */
  conflict?: string;
}

/** 计算结果上的失败诊断（无法转换/不闭合/多解） */
export interface Diagnosis {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  at?: PixelIndex;
  /** 无法转换时保留在原位置的原始值 */
  rawValue?: number;
  rawUnit?: string;
}
