/**
 * 干涉条纹簿 —— 领域数据契约
 *
 * 所有实体直接使用光学干涉 / 相位展开 / 标定领域自己的词汇：
 * 原相位像素(wrapped_phase_pixel)、信噪评分(signal_to_noise_score)、无效遮罩(invalid_mask)、
 * 波长(wavelength)、入射几何(illumination_geometry)、标定面(calibration_surface)、
 * 切口编辑历史(cut_edit_history)，以及残差电荷、支路切口网络、展开树、循环残差、
 * 整周候选、表面高度转换链与人工裁定事件。
 *
 * 不可变原则：原始输入一经提交不可覆盖，修订以「新版本 + 父版本」表达；
 * 每个派生值都带算法版本、参数指纹与直接来源引用。
 */

export type Unit = string; // 如 'radian' | 'nanometer' | 'micrometer' | 'dimensionless' | 'degree'

/** 带单位/坐标基准的物理量。导入时保留原始表示，派生层才做规范化。 */
export interface Quant {
  value: number;
  unit: Unit;
  /** 规范化到 SI 后的值；无法转换时留空并在 conversionDiagnostic 说明，值留在原位置。 */
  siValue?: number;
  conversionDiagnostic?: string;
}

/** 像素坐标基准（数组以 row-major 存储，row 0 在顶行；origin 描述物理坐标原点）。 */
export interface CoordinateBasis {
  rows: number;
  cols: number;
  origin: 'top-left';
  physicalBasis: string; // 例如 'pixel-index，物理坐标由标定面给出'
  pixelPitch?: Quant; // 像元尺寸（可选）
}

export type RawEntityKind =
  | 'wrapped_phase_frame'
  | 'amplitude_frame'
  | 'quality_score_map'
  | 'invalid_mask'
  | 'wavelength'
  | 'illumination_geometry'
  | 'calibration_surface'
  | 'cut_edit_history';

export type DerivedEntityKind =
  | 'residue_charge_map'
  | 'branch_cut_network'
  | 'unwrap_tree'
  | 'cycle_residual_set'
  | 'integer_candidate_set'
  | 'unwrapped_solution'
  | 'height_field';

export type EntityKind = RawEntityKind | DerivedEntityKind | 'local_lock' | 'review_event';

/**
 * 直接来源引用。查询任一实体必须能返回它引用的版本号与内容摘要；
 * 缺少引用、版本不存在或摘要不一致都按「损坏」处理，绝不退回当前最新版。
 */
export interface SourceRef {
  kind: EntityKind;
  entityId: string;
  versionId: string;
  contentHash: string;
  /** 若只依赖该版本的一部分（如共享原始片段），记录片段坐标/键。 */
  fragment?: string;
}

export type RecordStatus = 'current' | 'stale' | 'superseded' | 'rejected' | 'unknown';

/** 所有可持久化记录的公共头 */
export interface RecordHeader {
  kind: EntityKind;
  /** 跨版本稳定的实体身份 */
  entityId: string;
  /** 该版本自身的身份（导出/删除/导入后保持不变） */
  versionId: string;
  parentVersionId: string | null;
  contentHash: string;
  algorithmVersion?: string;
  parameterFingerprint?: string;
  sources: SourceRef[];
  status: RecordStatus;
  createdAt: string; // 虚拟时间 ISO 字符串
  supersededByVersionId?: string;
  /** 该记录被判定过期的原因（直接来源变更等） */
  staleReason?: string;
}

// ---------------------------------------------------------------------------
// 原始输入实体（不可覆盖）
// ---------------------------------------------------------------------------

/** 原相位像素：包裹相位，单位 radian，主值区间；保留导入时的原始表示 */
export interface WrappedPhaseFrame extends RecordHeader {
  kind: 'wrapped_phase_frame';
  coordinateBasis: CoordinateBasis;
  phaseUnit: Unit; // 原始单位，通常 'radian'
  principalRange: '(-pi, pi]';
  /** row-major 长度 rows*cols；低振幅/被遮罩像素也保留原相位像素值，不猜、不删 */
  values: number[];
}

/** 振幅帧 */
export interface AmplitudeFrame extends RecordHeader {
  kind: 'amplitude_frame';
  coordinateBasis: CoordinateBasis;
  amplitudeUnit: Unit; // 原始单位
  values: number[];
}

/** 信噪评分（逐像素；dimensionless，分数越低越不可信） */
export interface QualityScoreMap extends RecordHeader {
  kind: 'quality_score_map';
  coordinateBasis: CoordinateBasis;
  scoreUnit: 'dimensionless';
  method: string; // 评分方法（来自实验室导入，不重算覆盖）
  values: number[];
}

/** 无效遮罩：true 表示无效像素；附逐像素原因码 */
export interface InvalidMask extends RecordHeader {
  kind: 'invalid_mask';
  coordinateBasis: CoordinateBasis;
  invalid: boolean[];
  reason: (string | null)[];
}

/** 波长（版本化：波长版本变更产生新版本，父版本保留） */
export interface Wavelength extends RecordHeader {
  kind: 'wavelength';
  wavelength: Quant;
}

/** 入射几何：入射角、敏感矢量方向与几何模型 */
export interface IlluminationGeometry extends RecordHeader {
  kind: 'illumination_geometry';
  incidenceAngle: Quant; // 入射角（原始单位保留）
  sensitivityModel: string; // 如 'single-illumination: dz = dphi*lambda/(2pi*(1+cos(theta)))'
  illuminationVector: { x: number; y: number; z: number }; // 单位方向矢量
}

/** 标定面：参考面（平面系数或高度图）及其坐标基准/单位 */
export interface CalibrationSurface extends RecordHeader {
  kind: 'calibration_surface';
  coordinateBasis: CoordinateBasis;
  model: 'plane-affine' | 'height-grid';
  plane?: { a: Quant; b: Quant; c: Quant }; // z = a*x + b*y + c
  grid?: number[]; // model = height-grid 时的参考高度（row-major）
  heightUnit: Unit;
}

/** 支路切口（像素边）：水平边连接 (r,c)-(r,c+1)，垂直边连接 (r,c)-(r+1,c) */
export interface CutEdge {
  edgeId: string;
  orientation: 'horizontal' | 'vertical';
  r: number;
  c: number;
  origin: 'algorithm' | 'manual';
  /** 切口两侧显式表示的整周偏移 k（相位阶跃 = 2πk 弧度）；未知时为 null */
  integerOffset: number | null;
  reason: string;
}

/** 切口编辑历史：不可变版本，每次编辑以「追加一批 add/remove + 父版本」表达 */
export interface CutEditHistory extends RecordHeader {
  kind: 'cut_edit_history';
  added: CutEdge[];
  removed: string[]; // 被移除边的 edgeId
  editor: string;
  note: string;
}

export type RawEntity =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | QualityScoreMap
  | InvalidMask
  | Wavelength
  | IlluminationGeometry
  | CalibrationSurface
  | CutEditHistory;

// ---------------------------------------------------------------------------
// 派生实体
// ---------------------------------------------------------------------------

/** 残差电荷：2x2 回路的包裹梯度卷绕和，charge ∈ {-1,0,+1}（单位：整周 cycle） */
export interface Residue {
  cellR: number; // 左上角行
  cellC: number; // 左上角列
  charge: -1 | 0 | 1;
  wrapSumRad: number; // 主值卷绕后的回路和
  quality: number; // 该回路可信度
}

export interface ResidueChargeMap extends RecordHeader {
  kind: 'residue_charge_map';
  coordinateBasis: CoordinateBasis;
  residues: Residue[];
  positiveCount: number;
  negativeCount: number;
}

export interface BranchCutNetwork extends RecordHeader {
  kind: 'branch_cut_network';
  coordinateBasis: CoordinateBasis;
  edges: CutEdge[];
  /** 与边界相连的残差（dipoles-to-border），便于多连通区分析 */
  borderTerminations: { r: number; c: number }[];
}

/** 展开树（或森林）边：相邻像素间的整周增量与包裹差分 */
export interface TreeEdge {
  edgeId: string;
  orientation: 'horizontal' | 'vertical';
  r: number;
  c: number;
  k: number; // 整周增量
  wrappedDeltaRad: number;
  crossesCut: boolean;
  blocked: boolean; // 低振幅/遮罩/切口阻断 → 不进入树
  blockReason?: string;
}

/** 不同展开树可得到局部一致解：路径与每棵树的覆盖区域都保留 */
export interface UnwrapTree extends RecordHeader {
  kind: 'unwrap_tree';
  treeId: string;
  root: { r: number; c: number };
  edges: TreeEdge[];
  coveredPixels: number;
  /** 因低振幅孔洞/遮罩/切口而未覆盖的像素（这些像素不猜相位） */
  uncoveredPixels: { r: number; c: number; reason: string }[];
}

/** 循环残差：沿闭合路径累加的整周残差；不为零即循环不闭合 */
export interface CycleResidual {
  cycleId: string;
  path: { r: number; c: number }[];
  edges: string[]; // TreeEdge.edgeId / CutEdge.edgeId
  wrappedSumRad: number;
  residualCycles: number; // 理想 0；非 0 即不闭合
  closed: boolean;
  crossesBranchCut: boolean;
  note: string;
}

export interface CycleResidualSet extends RecordHeader {
  kind: 'cycle_residual_set';
  cycles: CycleResidual[];
  maxAbsResidualCycles: number;
}

/** 整周候选：无法唯一决定时保留全部合法候选与拒绝原因 */
export interface IntegerCandidate {
  candidateId: string;
  pixel: { r: number; c: number };
  k: number; // 整周数
  legal: boolean;
  rejectReason?: string;
  score: number; // 路径/质量一致性评分
  sourceCycleIds: string[];
}

export interface IntegerCandidateSet extends RecordHeader {
  kind: 'integer_candidate_set';
  candidates: IntegerCandidate[];
  ambiguity: boolean; // 是否存在多个被采纳候选（整周多解）
}

/** 展开解：逐像素连续相位；未知像素显式 unknown，绝不猜 */
export interface UnwrappedSolution extends RecordHeader {
  kind: 'unwrapped_solution';
  coordinateBasis: CoordinateBasis;
  treeRefs: SourceRef[];
  phaseRad: (number | null)[]; // null = 未知（低振幅孔洞/遮罩/未覆盖）
  unknownReason: (string | null)[];
  integerOffset: (number | null)[]; // 相对包裹相位的整周 k
  acceptedCandidateId: (string | null)[];
}

/** 高度转换链的每一步（相位 → 光程差 → 高度 → 扣除标定面），可逐步重放 */
export interface HeightChainStep {
  stepId: string;
  operation: string;
  formula: string;
  inputs: SourceRef[];
  parameterFingerprint: string;
}

export interface HeightField extends RecordHeader {
  kind: 'height_field';
  coordinateBasis: CoordinateBasis;
  heightUnit: Unit;
  height: (number | null)[];
  unknownReason: (string | null)[];
  chain: HeightChainStep[];
}

export type DerivedEntity =
  | ResidueChargeMap
  | BranchCutNetwork
  | UnwrapTree
  | CycleResidualSet
  | IntegerCandidateSet
  | UnwrappedSolution
  | HeightField;

// ---------------------------------------------------------------------------
// 复核实体
// ---------------------------------------------------------------------------

/** 显示值的稳定身份：锁定局部解读时锁定的是「某数据集某版本某坐标某字段」 */
export interface ValueIdentity {
  datasetVersionId: string;
  entityId: string;
  field: string;
  r?: number;
  c?: number;
}

export interface LocalLock extends RecordHeader {
  kind: 'local_lock';
  lockId: string;
  region: { r: number; c: number }[];
  lockedValues: ValueIdentity[];
  chosenCandidateId: string | null;
  reviewer: string;
  note: string;
  conflict: boolean;
  conflictWithLockId: string | null;
  conflictReason: string | null;
  active: boolean;
}

export type ReviewEventType =
  | 'input_committed'
  | 'input_revised'
  | 'derived_computed'
  | 'derived_stale'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'local_locked'
  | 'local_unlocked'
  | 'lock_conflict'
  | 'param_adjusted'
  | 'solution_accepted'
  | 'solution_rejected'
  | 'exported'
  | 'imported'
  | 'diagnostic';

/** 机器可读取的裁定/判断事件（采纳与未采纳的结果都保留） */
export interface ReviewEvent {
  kind: 'review_event';
  seq: number;
  eventId: string;
  at: string;
  type: ReviewEventType;
  reviewer: string;
  summary: string;
  /** 判断依据：规则、阈值、证据引用，全部机器可读 */
  basis: {
    ruleId: string;
    ruleText: string;
    threshold?: number;
    evidence: SourceRef[];
  };
  affected: SourceRef[];
  payload: Record<string, unknown>;
  /** 该事件发生时所有相关实体所处的版本快照，回到此事件即恢复当时依赖与结论 */
  asOf: { entityId: string; versionId: string; contentHash: string }[];
  adopted: boolean; // 采纳 / 未采纳都保留
  parentEventId: string | null;
}

// ---------------------------------------------------------------------------
// 诊断与损坏
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'unknown';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  at?: { r: number; c: number };
  rawValue?: unknown;
}

export class CorruptReferenceError extends Error {
  constructor(
    public missing: SourceRef,
    detail: string,
  ) {
    super(`损坏的引用：${detail}`);
    this.name = 'CorruptReferenceError';
  }
}

export class ImportFormatError extends Error {
  constructor(
    public diagnostics: Diagnostic[],
  ) {
    super(`导入格式错误：${diagnostics.map((d) => `[${d.code}] ${d.message}`).join('; ')}`);
    this.name = 'ImportFormatError';
  }
}
