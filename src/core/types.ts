// 干涉条纹簿 —— 领域词汇类型定义
// 所有领域量都携带单位/坐标基准；导入时保留原始表示，派生层才做规范化。

export type Unit =
  | 'rad'
  | 'degree'
  | 'turn'
  | 'nm'
  | 'um'
  | 'mm'
  | 'm'
  | 'unitless'
  | 'count'
  | 'dimensionless';

export interface Quantity {
  /** 原始表示（导入文本/数值原样保留） */
  raw: string | number;
  /** 原始单位 */
  unit: Unit;
  /** 规范化后的数值（SI 基准）；无法转换时为 null */
  value: number | null;
  /** 无法转换的诊断；转换成功时省略 */
  diagnostic?: string;
}

export interface CoordBasis {
  id: string;
  name: string;
  /** 行/列方向单位（通常 'pixel'，可带物理间距） */
  axes: { name: 'row' | 'col'; unit: Unit; pitch?: Quantity }[];
  origin: { row: number; col: number };
}

export type FrameEntityKind =
  | 'wrappedPhaseFrame'
  | 'amplitudeFrame'
  | 'invalidMaskFrame'
  | 'wavelengthSpec'
  | 'illuminationGeometry'
  | 'calibrationPlane'
  | 'cutEditHistory';

export type DerivedEntityKind =
  | 'residueMap'
  | 'branchCutNetwork'
  | 'unwrappingCandidateSet'
  | 'unwrappedPhaseField'
  | 'heightField'
  | 'localLock';

export type EntityKind = FrameEntityKind | DerivedEntityKind | 'project';

export type EntityStatus = 'current' | 'stale' | 'rejected' | 'superseded';
export type LockStatus = 'active' | 'released' | 'conflict';

export type ScenarioCode =
  | 'PHASE_WRAP_BOUNDARY'
  | 'LOW_AMPLITUDE_HOLE'
  | 'MULTIPLE_CONNECTED_REGIONS'
  | 'UNCLOSED_CYCLE'
  | 'WAVELENGTH_VERSION_CHANGE'
  | 'INTEGER_AMBIGUITY'
  | 'LOCAL_LOCK_CONFLICT';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code: ScenarioCode;
  severity: DiagnosticSeverity;
  message: string;
  refs: string[];
  location?: { row: number; col: number };
}

export interface Pixel<T = number> {
  row: number;
  col: number;
  value: T;
}

export interface RawGrid {
  rows: number;
  cols: number;
  /** 与行主序等长；无法解析的单元格为 null */
  cells: (number | null)[];
  /** 保留每个单元格的原始表示（导入时原样） */
  rawCells: (string | number | null)[];
  /** 每个无法解析单元格的诊断 */
  cellDiagnostics: { index: number; raw: string | number | null; diagnostic: string }[];
}

export interface FrameRef {
  entityId: string;
  version: number;
  contentHash: string;
  summary: string;
}

export interface ParameterFingerprint {
  algorithm: string;
  algorithmVersion: string;
  params: Record<string, unknown>;
}

export interface EntityHeader {
  id: string;
  kind: EntityKind;
  version: number;
  parentId: string | null;
  projectId: string;
  contentHash: string;
  createdAtVirtual: number;
  createdByEventId: string;
  status: EntityStatus;
  /** 直接来源：缺引用即损坏，不能退回最新版 */
  sources: FrameRef[];
  parameterFingerprint?: ParameterFingerprint;
}

// ---------- 不可覆盖的输入实体内容 ----------

export interface WrappedPhaseFrame {
  header: EntityHeader;
  coordBasis: CoordBasis;
  phase: RawGrid;
  wrappedRange: { min: number; max: number; unit: Unit };
  scenarioTags: ScenarioCode[];
}

export interface AmplitudeFrame {
  header: EntityHeader;
  coordBasis: CoordBasis;
  amplitude: RawGrid;
  snrScore: RawGrid;
  /** 低于此评分的像素不得猜相位 */
  snrThreshold: Quantity;
  scenarioTags: ScenarioCode[];
}

export interface InvalidMaskFrame {
  header: EntityHeader;
  coordBasis: CoordBasis;
  invalid: RawGrid; // 1 = 无效遮罩
  scenarioTags: ScenarioCode[];
}

export interface WavelengthSpec {
  header: EntityHeader;
  wavelength: Quantity; // 波长，单位长度
  note?: string;
}

export interface IlluminationGeometry {
  header: EntityHeader;
  incidenceAngle: Quantity; // 入射几何：相对法线
  azimuth?: Quantity;
  setup: 'interferometer-normal' | 'fringe-projection' | 'custom';
}

export interface CalibrationPlane {
  header: EntityHeader;
  coordBasis: CoordBasis;
  /** 标定面高度（物理单位），允许带未知单元格 */
  surfaceHeight: RawGrid;
  heightUnit: Unit;
  datum: string; // 坐标基准名称
}

export interface CutEdit {
  editId: string;
  atVirtual: number;
  kind: 'add-cut' | 'remove-cut' | 'set-jump';
  a: { row: number; col: number };
  b: { row: number; col: number };
  /** 显式整周偏移（set-jump 时） */
  jump?: number;
  reason: string;
  operator: string;
}

export interface CutEditHistory {
  header: EntityHeader;
  edits: CutEdit[];
}

// ---------- 派生实体 ----------

export interface ResidueCharge {
  row: number;
  col: number;
  charge: 1 | -1;
  wrappedLoop: number;
}

export interface ResidueMap {
  header: EntityHeader;
  charges: ResidueCharge[];
  diagnostics: Diagnostic[];
}

export interface CutEdge {
  id: string;
  a: { row: number; col: number };
  b: { row: number; col: number };
  /** 切口两侧显式整周偏移（候选相关时为 null，由候选给出） */
  enforcedJump: number | null;
  origin: 'residue-pairing' | 'manual' | 'removed';
}

export interface BranchCutNetwork {
  header: EntityHeader;
  edges: CutEdge[];
  diagnostics: Diagnostic[];
}

export interface GraphNode {
  row: number;
  col: number;
  componentId: number;
}

export interface GraphEdge {
  id: string;
  a: { row: number; col: number };
  b: { row: number; col: number };
  wrappedDelta: number;
  /** 该边是否为切口（切口不可穿越） */
  isCut: boolean;
}

export interface TreePathStep {
  edgeId: string;
  jump: number;
}

export interface CycleResidual {
  cycleId: string;
  nodeSeq: { row: number; col: number }[];
  edgeIds: string[];
  wrappedSum: number;
  /** 以整周计的残差（0 = 闭合）；无法闭合时非零 */
  residualCycles: number;
  closed: boolean;
  explanation: string;
}

export interface UnwrappingCandidate {
  candidateId: string;
  rank: number;
  root: { row: number; col: number };
  componentId: number;
  /** 展开树：边 -> 整周跳变（显式） */
  treeEdges: { edgeId: string; jump: number }[];
  /** 非树边（切口）两侧的显式整周偏移 */
  cutJumps: { edgeId: string; jump: number }[];
  cycles: CycleResidual[];
  locallyConsistent: boolean;
  rejected: boolean;
  rejectReason?: string;
  solutionScore: number;
}

export interface UnwrappingCandidateSet {
  header: EntityHeader;
  grid: { rows: number; cols: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  components: { componentId: number; nodeCount: number }[];
  candidates: UnwrappingCandidate[];
  diagnostics: Diagnostic[];
}

export interface UnwrappedPhaseField {
  header: EntityHeader;
  candidateId: string;
  rows: number;
  cols: number;
  /** 每个有效像素一个值；低振幅/遮罩/未知为 null（绝不猜相位） */
  values: (number | null)[];
  unknownCells: { row: number; col: number; reason: string }[];
  diagnostics: Diagnostic[];
}

export interface HeightField {
  header: EntityHeader;
  candidateId: string;
  rows: number;
  cols: number;
  /** 高度转换链的系数（rad -> 长度） */
  sensitivity: { factor: number; formula: string; wavelength: FrameRef; geometry: FrameRef };
  values: (number | null)[];
  heightUnit: Unit;
  calibration?: FrameRef;
  diagnostics: Diagnostic[];
}

export interface LocalLock {
  header: EntityHeader;
  candidateSetId: string;
  region: { row: number; col: number }[];
  candidateId: string;
  status: LockStatus;
  note?: string;
  conflictWith?: string[];
  diagnostics: Diagnostic[];
}

export type DomainEntity =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | InvalidMaskFrame
  | WavelengthSpec
  | IlluminationGeometry
  | CalibrationPlane
  | CutEditHistory
  | ResidueMap
  | BranchCutNetwork
  | UnwrappingCandidateSet
  | UnwrappedPhaseField
  | HeightField
  | LocalLock;

// ---------- 事件 ----------

export type EventType =
  | 'project.created'
  | 'import.submitted'
  | 'input.revised'
  | 'computation.residues'
  | 'computation.branchcuts'
  | 'computation.unwrapping'
  | 'computation.height'
  | 'decision.candidate.accepted'
  | 'decision.candidate.rejected'
  | 'decision.lock.placed'
  | 'decision.lock.released'
  | 'decision.lock.conflict'
  | 'cut.edited'
  | 'diagnostic.emitted'
  | 'undo.recorded';

export interface DomainEvent {
  id: string;
  seq: number;
  projectId: string;
  type: EventType;
  atVirtual: number;
  /** 人类操作或算法标识 */
  actor: string;
  scenario?: ScenarioCode;
  payload: Record<string, unknown>;
  /** 该事件产生的实体（内容+头） */
  entity?: DomainEntity;
  /** 该事件附带的机器可读判断依据 */
  diagnostics?: Diagnostic[];
  /** 撤销指针（undo.recorded 时指向被撤销事件） */
  undoesEventId?: string;
  prevEventId: string | null;
  contentHash: string;
}

export interface ProjectState {
  projectId: string;
  name: string;
  createdAtVirtual: number;
  headEventId: string | null;
  entities: Map<string, DomainEntity>;
  headsByKind: Map<string, string>; // kind -> 最新实体 id（仅用于“当前”视图）
  events: DomainEvent[];
  clock: number;
  rngSeed: number;
}
