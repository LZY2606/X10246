/**
 * 干涉条纹簿 · 领域词汇与数据契约
 *
 * 该模块只定义“光学干涉 / 相位展开 / 标定”领域自己的实体词汇：
 * 原相位像素(wrappedPhaseFrame)、信噪评分(snrScoreMap)、无效遮罩(invalidMask)、
 * 波长(wavelengthSpec)、入射几何(illuminationGeometry)、标定面(calibrationPlane)、
 * 切口编辑历史(branchCutEditLog) 均为不可覆盖的输入实体；
 * 展开树(unwrapTree)、整周偏移候选(integerCycleCandidateSet)、
 * 循环残差(cycleResidualSet)、高度表面(heightSurface)、
 * 局部锁定(localLock) 为派生 / 决定实体。
 *
 * 规则：不使用通用 name/value 表；每个值携带单位或坐标基准；
 * 原始表示保留在 raw 中，规范化结果只存在于派生层。
 */

export const ALGORITHM_VERSION = 'unwrap/least-cost-residue-tree@1.0.0';
export const NORMALIZER_VERSION = 'normalize/grid-frame@1.0.0';
export const HEIGHT_CHAIN_VERSION = 'height-chain/wavelength-geometry-plane@1.0.0';
export const CONTRACT_VERSION = 'fringe-ledger/1';

/** 所有物理量携带的单位（SI 优先） */
export type Unit =
  | 'radian'            // 弧度（包裹相位）
  | 'nanometer'         // 波长
  | 'dimensionless'     // 无量纲（振幅/信噪比）
  | 'degree'            // 入射角角度
  | 'millimeter';       // 表面高度 / 标定面

/** 坐标基准：以矩阵左上角为 (0,0) 的像素坐标，行优先，外加可选物理像素间距 */
export interface CoordinateBasis {
  origin: 'top-left';
  ordering: 'row-major';
  rowIndex: string; // 'r'
  colIndex: string; // 'c'
  pixelPitchMm: number;
  pixelPitchUnit: 'millimeter/pixel';
}

/** 二维格帧：原始表示字符串数组 + 规范化的数值矩阵；无法转换的值保留在原位置并附诊断 */
export interface GridFrame {
  rows: number;
  cols: number;
  /** 原始表示（保留导入时的字符串原样，不覆盖、不规范化） */
  raw: string[];
  /** 规范化数值；无法转换处为 null，诊断见 defects */
  values: (number | null)[];
  unit: Unit;
  basis: CoordinateBasis;
  defects: CellDefect[];
}

export interface CellDefect {
  r: number;
  c: number;
  code:
    | 'not-a-number'        // 无法解析
    | 'out-of-physical-range'
    | 'missing-cell'
    | 'unit-mismatch';
  raw: string;
  message: string;
}

/** 输入实体种类（受“不可覆盖”约束的七类来源） */
export type InputEntityKind =
  | 'wrappedPhaseFrame'
  | 'amplitudeFrame'
  | 'snrScoreMap'
  | 'invalidMask'
  | 'wavelengthSpec'
  | 'illuminationGeometry'
  | 'calibrationPlane'
  | 'branchCutEditLog';

/** 派生 / 决定实体种类 */
export type DerivedEntityKind =
  | 'normalizedFrame'
  | 'residueChargeMap'
  | 'branchCutNetwork'
  | 'unwrapTree'
  | 'cycleResidualSet'
  | 'integerCycleCandidateSet'
  | 'unwrappedPhaseField'
  | 'heightSurface'
  | 'localLock'
  | 'reviewDecision';

export type EntityKind = InputEntityKind | DerivedEntityKind;

export type PhaseWrap = '[-pi,pi)' | '[0,2pi)';

/** 包裹相位帧（原相位像素） */
export interface WrappedPhasePayload {
  frame: GridFrame;
  wrap: PhaseWrap;
  fringeCountHint?: number;
}

/** 振幅帧（决定低振幅孔洞，低振幅区域不得猜相位） */
export interface AmplitudePayload {
  frame: GridFrame;
  /** 低振幅阈值（无量纲），低于它的像素不允许整周赋值 */
  lowAmplitudeThreshold: number;
}

/** 信噪评分（质量图来源） */
export interface SnrPayload {
  frame: GridFrame;
}

/** 无效遮罩：1/true = 无效（孔洞、多连通区的边界材料） */
export interface InvalidMaskPayload {
  frame: GridFrame;
  invalidWhen: 'one' | 'nonzero';
}

/** 波长（波长版本变更的载体） */
export interface WavelengthPayload {
  wavelength: number;
  unit: 'nanometer';
  source: string;        // 例如激光器序列号/通道
  revisionNote: string;
}

/** 入射几何 */
export interface IlluminationGeometryPayload {
  incidenceAngleDeg: number; // 与法线夹角
  angleUnit: 'degree';
  sensitivityVector: { dx: number; dy: number; dz: number }; // 单位向量分量
  note?: string;
}

/** 标定面（高度转换链的零平面，z = a r + b c + d） */
export interface CalibrationPlanePayload {
  equation: { a: number; b: number; d: number }; // 毫米/行、毫米/列、毫米偏移
  unit: 'millimeter';
  residualRmsMm: number;
  calibratedAt?: string;
}

/** 切口编辑（人工切口，append-only） */
export interface BranchCutEdit {
  editId: string;
  at: string; // ISO 虚拟时间
  op: 'add-cut' | 'remove-cut';
  /** 边 {r1,c1}-{r2,c2}；切口两侧整周偏移必须显式表示 */
  edge: { r1: number; c1: number; r2: number; c2: number };
  /** 该切口两侧显式整周跳变（可为 null 表示编辑时未指定） */
  explicitCycleJump: number | null;
  reason: string;
}
export interface BranchCutEditLogPayload {
  edits: BranchCutEdit[];
}

export type InputPayload =
  | ({ kind: 'wrappedPhaseFrame' } & WrappedPhasePayload)
  | ({ kind: 'amplitudeFrame' } & AmplitudePayload)
  | ({ kind: 'snrScoreMap' } & SnrPayload)
  | ({ kind: 'invalidMask' } & InvalidMaskPayload)
  | ({ kind: 'wavelengthSpec' } & WavelengthPayload)
  | ({ kind: 'illuminationGeometry' } & IlluminationGeometryPayload)
  | ({ kind: 'calibrationPlane' } & CalibrationPlanePayload)
  | ({ kind: 'branchCutEditLog' } & BranchCutEditLogPayload);

/** 相位残差电荷：+1/-1/0（2x2 缠绕梯度和归一化） */
export interface ResidueChargeMapPayload {
  rows: number;
  cols: number;
  charges: number[]; // 以左上角像素为索引，仅左上角电荷有意义，长度 rows*cols
}

/** 支路切口网络（含人工切口；边携带显式整周跳变） */
export interface BranchCutNetworkPayload {
  cuts: CutEdge[];
}
export interface CutEdge {
  uid: string;
  r1: number; c1: number; r2: number; c2: number;
  origin: 'residue-pairing' | 'manual-edit';
  /** 切口两侧的显式整周偏移（未知为 null，绝不猜测） */
  explicitCycleJump: number | null;
}

/** 展开树：边与根；不同展开树可得到局部一致解 */
export interface UnwrapTreePayload {
  rootCell: string; // 'r,c'
  edges: TreeNodeEdge[];
  rejectedEdges: { r1: number; c1: number; r2: number; c2: number; reason: string }[];
  strategy: string;
}
export interface TreeNodeEdge {
  r1: number; c1: number; r2: number; c2: number;
  wrappedDelta: number;   // rad
  cycleJump: number;      // 边上整周数（-1/0/+1）
  crossesLowAmplitude: boolean;
}

/** 独立循环及其闭合残差（单位：rad，理想为 0；不闭合 > 容差即诊断） */
export interface CycleResidualSetPayload {
  toleranceRad: number;
  cycles: CycleResidual[];
}
export interface CycleResidual {
  uid: string;
  cells: string[];          // 闭合走一圈的像素
  wrappedSumRad: number;    // 缠绕梯度求和
  cycleJumpSum: number;     // 树上整周之和
  residualRad: number;      // = wrappedSum - 2π * cycleJumpSum（取缠绕）
  closed: boolean;
}

/** 整周候选集：无法唯一决定时保留全部合法候选，并记录拒绝原因 */
export interface IntegerCycleCandidateSetPayload {
  regions: AmbiguousRegion[];
}
export interface AmbiguousRegion {
  uid: string;
  anchorCell: string;
  /** 全部合法候选（k 为整周数） */
  candidates: { k: number; score: number; rejected: boolean; rejectReason?: string }[];
  resolved: boolean;
  chosenK?: number;
}

/** 展开相位场：未知像素保留 null（低振幅/无效区不猜） */
export interface UnwrappedPhaseFieldPayload {
  rows: number;
  cols: number;
  /** 每像素 {v: 展开相位 rad | null, k: 整周 | null, status, reason?} */
  cells: UnwrappedCell[];
  unit: 'radian';
}
export interface UnwrappedCell {
  v: number | null;
  k: number | null;
  status: 'integrated' | 'low-amplitude-unknown' | 'invalid-mask' | 'disconnected';
}

/** 高度转换链：显式保存每一步与所用来源版本 */
export interface HeightSurfacePayload {
  rows: number;
  cols: number;
  cells: HeightCell[];
  unit: 'millimeter';
  chain: HeightChainStep[];
}
export interface HeightCell {
  v: number | null;
  status: UnwrappedCell['status'] | 'unconvertible';
}
export interface HeightChainStep {
  step: string;
  formula: string;
  inputs: { wavelengthVersion?: string; geometryVersion?: string; planeVersion?: string; unwrappedVersion?: string };
}

/** 局部锁定：审阅者锁定某区域的整周解读；与既有锁定冲突时记录冲突 */
export interface LocalLockPayload {
  regionUid: string;
  anchorCell: string;
  cells: string[];
  k: number;
  conflictsWith?: string[]; // 与之冲突的其它 localLock 实体版本 uid
  note?: string;
}

export type ReviewVerdict = 'accepted' | 'rejected' | 'parameter-adjusted';
export interface ReviewDecisionPayload {
  verdict: ReviewVerdict;
  targetVersion: string;      // 被审阅的派生版本 uid
  parameterChanges?: Record<string, number | string>;
  note: string;
}

export type DerivedPayload =
  | ({ kind: 'residueChargeMap' } & ResidueChargeMapPayload)
  | ({ kind: 'branchCutNetwork' } & BranchCutNetworkPayload)
  | ({ kind: 'unwrapTree' } & UnwrapTreePayload)
  | ({ kind: 'cycleResidualSet' } & CycleResidualSetPayload)
  | ({ kind: 'integerCycleCandidateSet' } & IntegerCycleCandidateSetPayload)
  | ({ kind: 'unwrappedPhaseField' } & UnwrappedPhaseFieldPayload)
  | ({ kind: 'heightSurface' } & HeightSurfacePayload)
  | ({ kind: 'localLock'; lockId: string } & LocalLockPayload)
  | ({ kind: 'reviewDecision'; decisionId: string } & ReviewDecisionPayload);

/** 反例情形标签（七种 + 组合） */
export type CounterCaseTag =
  | 'phase-wrap-boundary'
  | 'low-amplitude-hole'
  | 'multiply-connected-region'
  | 'cycle-nonclosure'
  | 'wavelength-version-change'
  | 'integer-multiplicity'
  | 'local-lock-conflict';
