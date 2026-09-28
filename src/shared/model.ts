/**
 * 干涉条纹簿 —— 领域数据契约。
 *
 * 设计原则（对应验收）：
 *  - 原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史均不可覆盖。
 *  - 不把一切压成 name/value：直接采用相位展开/支路切口/光学标定自己的词汇。
 *  - 低振幅区域不得猜相位；切口两侧的整周偏移要显式表示。
 *  - 不同展开树可得到局部一致解，需保留路径与循环残差。
 *  - 每个显示值都带稳定身份（stableId）。
 */
import type { AngleUnit, CoordinateFrame, LengthUnit } from './units.js';

export type PixelStatus = 'valid' | 'invalid-mask' | 'low-amplitude';

/** 二维格网几何。row 向下，col 向右，0 基。 */
export interface GridGeometry {
  rows: number;
  cols: number;
  frame: CoordinateFrame;
}

export interface MatrixLayer<T> {
  /** 行优先（row-major）扁平数组，长度 rows*cols */
  values: T[];
  unit?: string;
}

/** 包裹相位像素（wrapped phase），范围约 (-pi, pi]，保留原始表示 */
export interface WrappedPhaseLayer {
  kind: 'wrapped-phase';
  values: number[];
  unit: AngleUnit;
  /** 若导入时即非 (-pi,pi]，记录原始区间，派生层规范化时使用 */
  declaredRange?: [number, number];
}

/** 振幅层（干涉条纹调制度 / 幅度） */
export interface AmplitudeLayer {
  kind: 'amplitude';
  values: number[];
  unit: string; // 如 'adu'、'counts'、'a.u.'
}

/** 无效遮罩：true = 无效（孔洞、饱和、遮挡） */
export interface InvalidMaskLayer {
  kind: 'invalid-mask';
  values: boolean[];
  reason?: string[];
}

/** 信噪评分（quality map 来源之一），[0,1]，越高越可信 */
export interface SnrScoreLayer {
  kind: 'snr-score';
  values: number[];
  unit: 'ratio';
}

/** 波长版本。波长可被修订，必须以新版本+父版本关系表达，不可覆盖。 */
export interface WavelengthSpec {
  wavelengthId: string;
  parentId: string | null;
  value: number;
  unit: LengthUnit;
  /** 介质折射率（空气≈1），用于光程差 */
  refractiveIndex: number;
  revisionNote: string;
}

/** 入射几何：照明/观察方向。支持离轴与等效垂直入射。 */
export interface IncidenceGeometry {
  geometryId: string;
  /** 入射光与表面法线夹角 */
  incidenceAngle: number;
  angleUnit: AngleUnit;
  /** 灵敏度模型：垂直入射 h = phi*lambda/(4pi)；离轴给出有效灵敏度系数 */
  model: 'normal-incidence' | 'tilted-illumination';
  /** 离轴时 h = phi * sensitivityFactor（单位：米/弧度），由几何显式给出 */
  sensitivityFactorMetersPerRad?: number;
}

/** 标定面：把像素/相位与物理高度联系起来，可含已知参考平面 */
export interface CalibrationPlane {
  calibrationId: string;
  parentId: string | null;
  /** 每像素物理尺度（米/像素）；不可得时为 null 并保留诊断 */
  pixelScaleMeters: number | null;
  /** 参考平面高度（米），表面高度为相对该面 */
  referenceHeightM: number;
  /** 平面拟合残差（米），作为标定质量证据保留 */
  fitResidualM: number;
  note: string;
}

/** 切口（branch cut）不可变编辑历史中的一条边 */
export type CutEdgeKind = 'residue-residue' | 'residue-boundary';
export interface CutEdge {
  edgeId: string;
  /** 边的像素端点（边界切口第二端点为虚拟边界点） */
  a: [number, number];
  b: [number, number];
  boundary?: boolean;
  kind: CutEdgeKind;
}

export interface CutEdit {
  editId: string;
  parentEditId: string | null;
  action: 'add-cut' | 'remove-cut' | 'clear';
  edge?: CutEdge;
  /** 人工或算法；人工决定带操作者与理由 */
  origin: 'algorithm' | 'human';
  operator?: string;
  reason?: string;
}

/** 原始不可变输入包：一经提交不可覆盖 */
export interface RawSourceBundle {
  sourceId: string;
  parentSourceId: string | null;
  label: string;
  grid: GridGeometry;
  wrappedPhase: WrappedPhaseLayer;
  amplitude: AmplitudeLayer;
  invalidMask: InvalidMaskLayer;
  snr: SnrScoreLayer;
  wavelength: WavelengthSpec;
  geometry: IncidenceGeometry;
  calibration: CalibrationPlane;
  /** 切口编辑历史是追加型的不可覆盖序列 */
  cutHistory: CutEdit[];
  createdAtVirtual: number;
}

/** 质量图：每个像素一个可信度，附来源（振幅/snr） */
export interface QualityMap {
  kind: 'quality-map';
  values: number[];
  contributors: Array<'amplitude' | 'snr' | 'mask'>;
}

/** 包裹梯度环绕的残差点（2x2 plaquette 电荷 ±1） */
export interface Residue {
  residueId: string;
  /** plaquette 左上角像素坐标 */
  at: [number, number];
  charge: 1 | -1;
  /** 是否触及无效/低振幅区域，触及则不能被常规路径穿越 */
  touchesBlocked: boolean;
}

export type ResidueCharge = 1 | -1;

/** 展开树的一条边：记录沿该边采用的整周 k 与梯度 */
export interface TreeEdge {
  edgeId: string;
  from: [number, number];
  to: [number, number];
  /** 跨越这条边时加入的整周数 k（unwrapped = wrapped + 2pi*k） */
  wrapK: number;
  /** 包裹梯度 wrap(dphi)，弧度 */
  wrappedGradRad: number;
  blocked: boolean;
}

/** 一条展开路径（树中从锚点到某像素的路径），用于可复查 */
export interface UnwrapPath {
  target: [number, number];
  edgeIds: string[];
  /** 路径累计整周数 */
  cumulativeK: number;
}

/** 循环残差：闭合环路积分后剩余的整周数（理想=0；切口/残差附近非0） */
export interface CycleResidual {
  cycleId: string;
  edgeIds: string[];
  /** 环路积分残差（弧度，约等于 2pi*integerCycles） */
  residualRad: number;
  /** 折合的整周数 */
  integerCycles: number;
  closed: boolean;
}

/** 展开像素：合法/未知（低振幅、遮罩），未知绝不猜 */
export type UnwrappedPixel =
  | { status: 'valid'; unwrappedRad: number; wrapK: number; pathEdgeIds: string[] }
  | { status: 'unknown'; reason: 'low-amplitude' | 'invalid-mask' | 'isolated'; };

export interface UnwrapTree {
  treeId: string;
  /** 多连通分量：每个被遮罩/孔洞隔开的区域一棵子树 */
  componentId: string;
  anchor: [number, number];
  edges: TreeEdge[];
  paths: UnwrapPath[];
  cycles: CycleResidual[];
  pixels: MatrixLayer<UnwrappedPixel>;
  /** 被切口分开的两侧，整周偏移显式表示；null=不唯一/未定 */
  cutOffsets: Array<{ edgeId: string; offsetCycles: number | null }>;
}

/** 整周多解：无法唯一决定时保留全部合法候选 */
export interface IntegerCandidate {
  candidateId: string;
  pixel: [number, number];
  /** 合法的整周 k 候选集合（已排序） */
  kOptions: number[];
  /** 采纳的 k；null=尚未裁定 */
  acceptedK: number | null;
  ambiguityReason:
    | 'low-amplitude-gap'
    | 'cycle-mismatch'
    | 'multi-component-anchor'
    | 'cut-crossing';
}

/** 拒绝原因作为一等数据 */
export interface RejectedCandidate {
  candidateId: string;
  k: number;
  rejectReason: string;
}

/** 表面高度转换链：相位 -> 光程差 -> 高度，保留每步来源与单位 */
export interface HeightChain {
  chainId: string;
  wavelengthId: string;
  geometryId: string;
  calibrationId: string;
  heightMeters: Array<number | null>;
  /** 无法转换（如缺标定的像素长度）保留 null + 诊断 */
  diagnostics: Array<{ index: number; code: string; message: string }>;
}

/** 判定状态机 */
export type VerdictStatus =
  | 'generated'
  | 'in-review'
  | 'accepted'
  | 'rejected'
  | 'superseded'
  | 'stale'
  | 'conflict';

export type CounterexampleKind =
  | 'phase-crossing-boundary'
  | 'low-amplitude-hole'
  | 'multiply-connected-region'
  | 'unclosed-cycle'
  | 'wavelength-version-change'
  | 'integer-multiplicity'
  | 'local-lock-conflict';

/** 局部锁定：审阅者锁定某像素/分量的局部解读 */
export interface LocalLock {
  lockId: string;
  pixel: [number, number];
  lockedK: number;
  ownerEventId: string;
  note?: string;
}

/** 失败诊断：候选、拒绝、误差、未知都是一等数据 */
export interface FailureDiagnostic {
  code: string;
  message: string;
  targetStableId?: string;
}
