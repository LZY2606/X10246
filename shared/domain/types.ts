// 干涉条纹簿 —— 领域词汇（直接使用光学干涉/相位展开/标定术语，禁止压成 name/value）

/** 单位或坐标基准：所有领域量都必须携带 */
export interface UnitSpec {
  /** 量纲，例如 radian / dimensionless / meter / 1/meter / none */
  kind: string;
  /** 单位符号，例如 rad、m、px、a.u. */
  symbol: string;
}

/** 二维网格公共结构 */
export interface Grid2D {
  width: number;
  height: number;
  /** 行主序长度 width*height */
  values: number[];
  /** 每个值的单位 */
  unit: UnitSpec;
}

/** 布尔/三态遮罩网格：1=有效,0=无效,null=未知（导入时未提供则视情况） */
export interface MaskGrid {
  width: number;
  height: number;
  valid: (0 | 1)[];
}

/** 像素坐标基准，原点与轴向显式保留 */
export interface CoordinateFrame {
  id: string;
  origin: 'top-left';
  axisU: 'column';
  axisV: 'row';
  /** 像素到物理坐标的步长（导入原值，派生层才规范化） */
  pitchU: { value: number; unit: UnitSpec };
  pitchV: { value: number; unit: UnitSpec };
}

// ---------- 原始输入实体（一经提交不可覆盖） ----------
export type InputKind =
  | 'wrapped_phase'
  | 'amplitude'
  | 'invalid_mask'
  | 'wavelength'
  | 'illumination_geometry'
  | 'calibration_plane'
  | 'cut_edit_history';

export interface WrappedPhaseInput {
  kind: 'wrapped_phase';
  frameId: string;
  width: number;
  height: number;
  /** 包裹相位（弧度），范围 [-pi,pi)，保留导入时的原始字符串表示 */
  raw: number[];
  /** 原始表示（JSON 序列化前的字符串形态，导入时保留） */
  rawRepresentation: string[];
  range: { minInclusive: number; maxExclusive: number; unit: UnitSpec };
  coordinateFrame: CoordinateFrame;
}

export interface AmplitudeInput {
  kind: 'amplitude';
  frameId: string;
  width: number;
  height: number;
  /** 振幅（光强相关），保留原始表示 */
  raw: number[];
  rawRepresentation: string[];
  unit: UnitSpec;
}

export interface InvalidMaskInput {
  kind: 'invalid_mask';
  frameId: string;
  width: number;
  height: number;
  /** 与振幅阈值判定无关的人工/仪器无效标记 */
  valid: (0 | 1)[];
  reason: string;
}

export interface WavelengthInput {
  kind: 'wavelength';
  /** 波长版本，例如 632.8 nm（He-Ne） */
  value: number;
  rawRepresentation: string;
  unit: UnitSpec;
}

export interface IlluminationGeometryInput {
  kind: 'illumination_geometry';
  /** 入射方向单位向量（实验室坐标），保留原始表示 */
  sourceDirection: { x: number; y: number; z: number };
  /** 观察方向单位向量 */
  observerDirection: { x: number; y: number; z: number };
  /** 灵敏度向量 = k_obs - k_in，保留原始表示；不可靠时留诊断 */
  sensitivityHint?: { x: number; y: number; z: number };
  rawRepresentation: string;
  coordinateFrame: CoordinateFrame;
}

export interface CalibrationPlaneInput {
  kind: 'calibration_plane';
  /** 参考平面 ax+by+cz+d=0，标定帧拟合得到，保留原始系数表示 */
  normal: { x: number; y: number; z: number };
  offset: number;
  offsetUnit: UnitSpec;
  residualRms: number;
  residualUnit: UnitSpec;
  rawRepresentation: string;
}

export interface CutEditEntry {
  at: string; // 虚拟时间 ISO 字符串
  editor: string;
  action: 'add' | 'remove' | 'confirm' | 'retract';
  edge: CutEdgeRef;
  note?: string;
}

export interface CutEditHistoryInput {
  kind: 'cut_edit_history';
  /** 切口编辑历史只能追加，不可覆盖；这里是提交时的不可变快照 */
  entries: CutEditEntry[];
}

export interface CutEdgeRef {
  /** 边端点像素 (u,v) */
  a: [number, number];
  b: [number, number];
}

export type InputPayload =
  | WrappedPhaseInput
  | AmplitudeInput
  | InvalidMaskInput
  | WavelengthInput
  | IlluminationGeometryInput
  | CalibrationPlaneInput
  | CutEditHistoryInput;

// ---------- 派生（复核）实体 ----------
export type DerivedKind =
  | 'quality_map'
  | 'residue_map'
  | 'branch_cut_network'
  | 'unwrapped_forest'
  | 'height_chain';

/** 信噪/质量评分（振幅与梯度导出，低振幅区域标记不可猜） */
export interface QualityMapPayload {
  kind: 'quality_map';
  width: number;
  height: number;
  /** 0..1 质量分；无效像素为 null */
  score: (number | null)[];
  /** 低振幅孔洞像素（来自振幅阈值 + 无效遮罩） */
  lowAmplitudeHole: (0 | 1)[];
  threshold: number;
  thresholdUnit: UnitSpec;
  /** 明确未知/不可信的像素，禁止猜相位 */
  unknownReason: (string | null)[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

/** 残差点（2x2 plaquette 缠绕和 / 2pi 的整周和） */
export interface ResidueCharge {
  u: number;
  v: number;
  charge: 1 | -1;
  value: number; // 实际缠绕和（rad）
}

export interface ResidueMapPayload {
  kind: 'residue_map';
  width: number;
  height: number;
  charges: ResidueCharge[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

/** 支路切口：每条切口边带显式整周跳转 */
export interface BranchCutEdge {
  id: string;
  a: [number, number];
  b: [number, number];
  /** 切口两侧的显式整周偏移 k（2π*k），未知则为 null（必须显式表示，不猜） */
  integerOffset: number | null;
  source: 'residue_pair' | 'manual' | 'border_guard';
  pairedResidues?: [ResidueCharge, ResidueCharge];
}

export interface BranchCutNetworkPayload {
  kind: 'branch_cut_network';
  width: number;
  height: number;
  edges: BranchCutEdge[];
  /** 未被配对的残差点（孔洞/边界） */
  unpairedResidues: ResidueCharge[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

/** 展开树候选的一条边 */
export interface UnwrapTreeEdge {
  id: string;
  a: [number, number];
  b: [number, number];
  /** 有向缠绕差 wrap(dphi) */
  wrappedDelta: number;
  /** 是否跨越 +/-pi 包裹边界 */
  crossesBranch: boolean;
  /** 该边的整周增量（随树固定） */
  k: number;
  /** 是否为切口边（切口边不参与树内传播） */
  cut: boolean;
}

export interface IntegerCandidate {
  /** 候选整周偏移 */
  k: number;
  /** 候选代价（与缠绕差一致性，越小越好） */
  cost: number;
  accepted: boolean;
  /** 未采纳原因（采纳则 null） */
  rejectReason: string | null;
}

/** 单个连通域上的一棵展开树（不同树=>局部一致、全局可能多解） */
export interface UnwrapTree {
  id: string;
  componentId: number;
  /** 树包含的像素 */
  pixels: [number, number][];
  edges: UnwrapTreeEdge[];
  /** 根像素 */
  root: [number, number];
  /** 该树采用的整周基准（根的绝对整周） */
  rootInteger: number;
}

/** 图中的一条环（多连通区/切口绕行）及其残差 */
export interface CycleResidual {
  id: string;
  componentId: number;
  /** 环经过的像素（闭合） */
  path: [number, number][];
  /** 缠绕和（rad，理论上闭合应为 0；非 0 即循环不闭合） */
  wrappedSum: number;
  /** 整周残差 round(wrappedSum/2π) */
  integerResidual: number;
  closed: boolean;
  /** 环内包含的残差点 */
  enclosedResidues: ResidueCharge[];
}

export interface UnwrappedForestPayload {
  kind: 'unwrapped_forest';
  width: number;
  height: number;
  trees: UnwrapTree[];
  /** 每个像素所属树 id（孔洞/无效为 null） */
  treeOf: (string | null)[];
  /** 展开相位（rad，相对各自树根基准）；低振幅/无效像素为 null */
  unwrappedPhase: (number | null)[];
  cycles: CycleResidual[];
  /** 整周边的多解候选（无法唯一决定时保留全部合法候选） */
  integerCandidates: Record<string, IntegerCandidate[]>;
  algorithmVersion: string;
  parameterFingerprint: string;
}

/** 高度转换链：每个阶段都是一等数据，可追溯 */
export interface HeightChainStage {
  id: string;
  stage:
    | 'unwrapped_phase'
    | 'fringe_order'
    | 'optical_path_difference'
    | 'sensitivity_projection'
    | 'surface_height';
  value: number | null;
  unit: UnitSpec;
  /** 无法转换的诊断（保留原值，不丢） */
  diagnostic?: string;
}

export interface HeightChainPayload {
  kind: 'height_chain';
  width: number;
  height: number;
  /** 像素 -> 转换链 */
  chains: Record<string, HeightChainStage[]>;
  /** 高度（相对标定面，m）；无法转换为 null 且链中保留诊断 */
  heights: (number | null)[];
  wavelengthVersion: string;
  algorithmVersion: string;
  parameterFingerprint: string;
}

export type DerivedPayload =
  | QualityMapPayload
  | ResidueMapPayload
  | BranchCutNetworkPayload
  | UnwrappedForestPayload
  | HeightChainPayload;

// ---------- 实体信封 ----------
export interface InputEntity {
  entityType: 'input';
  id: string;
  kind: InputKind;
  /** 语义版本 v1, v2...，原始输入新版本带父版本 */
  version: number;
  parentVersionId: string | null;
  /** 内容寻址哈希（原始字节规范化后） */
  contentHash: string;
  payload: InputPayload;
  committedAt: string;
  /** 导入时是否保留为无法规范化（留在原位+诊断） */
  diagnostics: string[];
}

export interface DerivedEntity {
  entityType: 'derived';
  id: string;
  kind: DerivedKind;
  version: number;
  contentHash: string;
  payload: DerivedPayload;
  algorithmVersion: string;
  parameterFingerprint: string;
  /** 直接来源：实体 id + 版本号，缺一即损坏 */
  sources: SourceRef[];
  computedAt: string;
  /** 是否过期（其直接来源已出新版本）；过期仍可查看，不能冒充当前 */
  stale: boolean;
  /** 若过期，指向取代它的更新派生 id */
  supersededBy: string | null;
}

export interface SourceRef {
  entityId: string;
  /** 引用必须锁定具体版本号 */
  version: number;
  /** 冗余内容摘要，用于损坏检测 */
  contentHash: string;
  role: string;
}

export type Entity = InputEntity | DerivedEntity;

// ---------- 人工裁定 / 锁定 ----------
export type DecisionVerdict = 'accepted' | 'rejected' | 'adjusted';

export interface DecisionRecord {
  id: string;
  targetEntityId: string;
  targetVersion: number;
  verdict: DecisionVerdict;
  /** 调整参数（如阈值、人工整周偏移） */
  adjustment?: Record<string, number | string>;
  reason: string;
  decidedAt: string;
  decider: string;
  /** 冲突解决时指向被否定的另一裁定 */
  conflictsWith?: string | null;
}

/** 局部解读锁定：把某个像素/区域的整周解读固定到具体版本 */
export interface LocalLock {
  id: string;
  scope: { kind: 'pixel' | 'region'; pixel?: [number, number]; pixels?: [number, number][] };
  treeId: string;
  /** 锁定的整周基准 */
  rootInteger: number;
  lockedEntityId: string;
  lockedVersion: number;
  lockedAt: string;
  locker: string;
  active: boolean;
  /** 若与后来的派生/另一锁定冲突 */
  conflictReason: string | null;
}

// ---------- 事件日志（append-only 状态机） ----------
export type EventType =
  | 'input_committed'
  | 'revision_committed'
  | 'cut_edited'
  | 'derivation_computed'
  | 'derivation_staled'
  | 'decision_made'
  | 'decision_retracted'
  | 'local_locked'
  | 'local_unlocked'
  | 'conflict_recorded'
  | 'conflict_resolved'
  | 'project_opened'
  | 'archive_imported';

export interface DomainEvent {
  seq: number;
  id: string;
  type: EventType;
  at: string;
  projectId: string;
  payload: unknown;
  /** 因果前驱（导入/导出后保持来源关系） */
  causationId: string | null;
}
