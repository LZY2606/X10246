/**
 * 干涉条纹簿 —— 领域词汇与数据契约
 *
 * 输入实体（全部不可覆盖，修订以新版本 + 父版本关系表达）：
 *   RawPhaseFrame       原相位像素（包裹相位，保留原始表示与单位 rad）
 *   QualityFrame        信噪评分 + 振幅（原始振幅保留在原始层）
 *   ValidityMask        无效遮罩（低振幅孔洞等）
 *   WavelengthSpec      波长（带单位，版本化）
 *   IncidenceGeometry   入射几何（角度、光轴约定、坐标基准）
 *   CalibrationSurface  标定面（标定帧/参考面）
 *   CutEdit             切口编辑（追加式，只增不改，构成切口编辑历史）
 *
 * 派生实体（带算法版本、参数指纹、直接来源）：
 *   QualityMap / ResidueMap / CutNetwork / FeasibleRegions
 *   UnwrapTree / CycleClosure / UnwrapCandidate / HeightMap
 *
 * 复核实体：
 *   Lock（局部解读锁定）/ Decision（接受、否定、参数调整）
 */

export type Cid = string;          // 内容身份：sha256 派生，稳定且跨导入/导出保持
export type EvtId = string;        // 事件身份：evt_<seq>_<hash8>
export type LineageId = string;    // 同一逻辑实体跨版本的稳定身份

export type InputKind =
  | 'RawPhaseFrame'
  | 'QualityFrame'
  | 'ValidityMask'
  | 'WavelengthSpec'
  | 'IncidenceGeometry'
  | 'CalibrationSurface';

export type DerivedKind =
  | 'QualityMap'
  | 'ResidueMap'
  | 'CutNetwork'
  | 'FeasibleRegions'
  | 'UnwrapTree'
  | 'CycleClosure'
  | 'UnwrapCandidate'
  | 'HeightMap';

export type EntityKind = InputKind | DerivedKind | 'CutEdit' | 'Lock' | 'Decision';

/** 直接来源引用：必须钉死具体版本，缺失即损坏，不允许退回最新版 */
export interface SourceRef {
  entityId: Cid;
  lineageId: LineageId;
  version: number;
  kind: EntityKind;
  /** 被引用内容的摘要（内容哈希前 12 位），用于完整性核对 */
  digest: string;
}

export interface AlgorithmProvenance {
  algorithm: string;
  algorithmVersion: string;
  /** 参数指纹：同样参数必得同样指纹 */
  parameterFingerprint: string;
  parameters: Record<string, number | string | boolean>;
  sources: SourceRef[];
}

/** 原始单元格：保留导入时的原始表示；无法转换的值留在原位并附诊断 */
export interface RawCell {
  x: number;
  y: number;
  raw: string;
  value: number | null;
  diagnostic: string | null;
}

export interface CoordBasis {
  /** 像素 (0,0) 对应的坐标 */
  origin: [number, number];
  dx: number;
  dy: number;
  units: string;          // 如 'um'
  crs: string;            // 坐标基准名称，如 'sensor-local-right-down'
}

export interface Grid2D {
  width: number;
  height: number;
  coordBasis: CoordBasis;
}

export interface Versioned {
  id: Cid;
  lineageId: LineageId;
  version: number;
  parentId: Cid | null;
  createdAtEvent: EvtId;
}

// ---------- 输入实体 ----------

export interface RawPhaseFrame extends Versioned {
  kind: 'RawPhaseFrame';
  grid: Grid2D;
  units: 'rad';
  phaseRange: '(-pi, pi]';
  cells: RawCell[];
}

export interface QualityFrame extends Versioned {
  kind: 'QualityFrame';
  grid: Grid2D;
  /** 振幅原始值（不做规范化） */
  amplitude: RawCell[];
  amplitudeUnits: string;          // 如 'counts(0-4095)'
  /** 导入侧给出的信噪评分；没有则为空，由派生层 QualityMap 估计 */
  snr: RawCell[];
  snrUnits: string;                // 如 'dB'
}

export interface ValidityMask extends Versioned {
  kind: 'ValidityMask';
  grid: Grid2D;
  /** true = 无效像素（含低振幅孔洞） */
  invalid: boolean[];
  reason: (string | null)[];
}

export interface WavelengthSpec extends Versioned {
  kind: 'WavelengthSpec';
  lambda: RawCellScalar;
}

export interface RawCellScalar {
  raw: string;
  value: number | null;
  units: string;                   // 'nm'
  diagnostic: string | null;
}

export interface IncidenceGeometry extends Versioned {
  kind: 'IncidenceGeometry';
  /** 入射光轴与表面法线夹角 */
  incidenceAngle: RawCellScalar;
  angleConvention: string;         // 'angle-from-normal'
  sensitivityModel: 'fringe-projection';
  /** 投影方向单位向量（传感器坐标基准） */
  projectionAxis: [number, number, number];
}

export interface CalibrationSurface extends Versioned {
  kind: 'CalibrationSurface';
  grid: Grid2D;
  /** 标定面参考包裹相位帧 */
  referencePhase: RawCell[];
  units: 'rad';
  planeFit: { a: number; b: number; c: number; rmsResidualRad: number } | null;
}

/** 切口编辑：只追加，永不可覆盖 */
export interface CutEdit extends Versioned {
  kind: 'CutEdit';
  action: 'add-cut' | 'remove-cut' | 'anchor-residue' | 'retract';
  /** 被撤销/移除的前一条切口编辑（撤销也写入历史） */
  retracts: Cid | null;
  edge?: [number, number, number, number]; // x1,y1,x2,y2 像素
  note: string;
}

// ---------- 派生实体 ----------

export type PixelStatus = 'valid' | 'low-amplitude-guarded' | 'masked';

export interface QualityMap {
  kind: 'QualityMap';
  id: Cid;
  provenance: AlgorithmProvenance;
  grid: Grid2D;
  /** 归一化质量 [0,1]；低振幅孔洞与无效遮罩处置为 0，绝不猜相位 */
  quality: number[];
  pixelStatus: PixelStatus[];
  diagnostics: string[];
}

/** 2x2 缠绕残差（支路电荷）：+1 / -1 / 0，单位：整周 */
export interface ResidueMap {
  kind: 'ResidueMap';
  id: Cid;
  provenance: AlgorithmProvenance;
  grid: Grid2D;
  /** 长度 (width-1)*(height-1)，charge 为缠绕和四舍五入到整周 */
  charge: number[];
  positiveResidues: [number, number][];
  negativeResidues: [number, number][];
}

export interface CutEdge {
  a: [number, number];
  b: [number, number];
  /** 切口两侧的整周偏移必须显式表示；null 表示尚未裁定（多解保留） */
  integerOrderAcross: number | null;
  source: 'manual' | 'auto-bipole';
  editId: Cid | null;
}

export interface CutNetwork {
  kind: 'CutNetwork';
  id: Cid;
  provenance: AlgorithmProvenance;
  edges: CutEdge[];
  /** 尚未配平的残差点（循环不闭合时非空） */
  unbalancedResidues: [number, number][];
  balanced: boolean;
}

export interface FeasibleRegion {
  id: number;
  pixels: number[];
  /** 孔洞（被无效像素包围形成的多连通结构） */
  enclosesHoles: number[];
}

export interface FeasibleRegions {
  kind: 'FeasibleRegions';
  id: Cid;
  provenance: AlgorithmProvenance;
  regions: FeasibleRegion[];
  pixelRegion: (number | null)[];
  multiConnected: boolean;
}

export interface TreeEdge {
  /** 像素索引 a -> b（4 邻域） */
  a: number;
  b: number;
  /** 该边上的整周增量：wrap(phi_b - phi_a) 的缠绕修正，单位 整周 */
  orderStep: number;
  crossesCut: boolean;
  cutEdgeIndex: number | null;
}

export interface UnwrapTree {
  kind: 'UnwrapTree';
  id: Cid;
  provenance: AlgorithmProvenance;
  regionId: number;
  rootPixel: number;
  edges: TreeEdge[];
  /** 父指针，便于路径还原 */
  parent: (number | null)[];
  /** 沿树的累积整周数（相对 root）；低振幅/无效像素为 null —— 不得猜相位 */
  integerOrder: (number | null)[];
  unwrappedRad: (number | null)[];
}

/** 非树边（弦）闭合检查：循环残差非零即循环不闭合 */
export interface CycleClosure {
  kind: 'CycleClosure';
  id: Cid;
  provenance: AlgorithmProvenance;
  chords: {
    a: number;
    b: number;
    directOrderStep: number;
    treePathOrder: number;
    /** 循环残差，单位 整周；理想为 0 */
    residualOrders: number;
    path: number[];
  }[];
  /** 包围残差点的 plaquette 循环残差（单位 整周） */
    plaquetteCycles: { at: [number, number]; charge: number }[];
  closed: boolean;
  maxAbsResidual: number;
}

export type CandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'conflicted';

export interface UnwrapCandidate {
  kind: 'UnwrapCandidate';
  id: Cid;
  provenance: AlgorithmProvenance;
  /** 生成该候选所用的 UnwrapTree 与 CutNetwork */
  treeId: Cid;
  regionId: number;
  /** 锚点像素及其整周基准；无锚时锚定自由度产生全部合法候选 */
  anchorPixel: number | null;
  anchorOrder: number;
  /** 每像素整周数（相对该候选锚定） */
  orders: (number | null)[];
  unwrappedRad: (number | null)[];
  /** 切口两侧显式整周偏移的赋值 */
  cutAssignments: { edgeIndex: number; integerOrderAcross: number }[];
  status: CandidateStatus;
  /** 未采纳原因（拒绝/冲突时必填） */
  rejectReason: string | null;
  ambiguityTag: string | null;
}

export interface HeightMap {
  kind: 'HeightMap';
  id: Cid;
  provenance: AlgorithmProvenance;
  candidateId: Cid;
  /** 高度转换链，逐步保留，不允许只给最终数字 */
  chain: {
    step: string;
    formula: string;
    units: string;
    perPixel: (number | null)[];
  }[];
  heightUm: (number | null)[];
  /** 无法转换的像素留在原位并附诊断 */
  diagnostics: Record<number, string>;
}

// ---------- 复核实体 ----------

export interface Lock {
  kind: 'Lock';
  id: Cid;
  lineageId: LineageId;
  version: number;
  parentId: Cid | null;
  createdAtEvent: EvtId;
  pixel: number;
  /** 锁定时看到的具体候选与整周数（钉死版本） */
  candidateId: Cid;
  lockedOrder: number;
  basis: string;
  active: boolean;
  retractedBy: Cid | null;
}

export type DecisionVerb = 'accept' | 'reject' | 'parameter-adjust';

export interface Decision {
  kind: 'Decision';
  id: Cid;
  lineageId: LineageId;
  version: number;
  parentId: Cid | null;
  createdAtEvent: EvtId;
  verb: DecisionVerb;
  targetCandidateId: Cid | null;
  note: string;
  /** parameter-adjust 时记录的新参数指纹事件 */
  parameterFingerprint: string | null;
  retractedBy: Cid | null;
  active: boolean;
}

export type StoredEntity =
  | RawPhaseFrame | QualityFrame | ValidityMask | WavelengthSpec
  | IncidenceGeometry | CalibrationSurface | CutEdit
  | QualityMap | ResidueMap | CutNetwork | FeasibleRegions
  | UnwrapTree | CycleClosure | UnwrapCandidate | HeightMap
  | Lock | Decision;

// ---------- 事件（追加式、哈希链） ----------

export type EventType =
  | 'ProjectCreated'
  | 'InputImported'          // 原始输入提交（v1）
  | 'InputRevised'           // 新版本输入（父版本关系）
  | 'CutEdited'
  | 'PipelineRun'            // 计算并提交派生实体
  | 'DecisionMade'
  | 'DecisionRetracted'      // 撤销（写入历史，不删除）
  | 'Locked'
  | 'LockRetracted'
  | 'ConflictDetected'       // 局部锁定冲突等，机器可读
  | 'ParameterRevised'
  | 'ProjectExported';

export interface FringeEvent {
  id: EvtId;
  seq: number;
  at: number;                // 虚拟时间（ms），由可注入时钟给出
  type: EventType;
  /** 哈希链：sha256(prevHash + canonical(payload)) */
  hash: string;
  prevHash: string;
  payload: Record<string, unknown>;
  /** 本事件产生/引用的实体（事件与对象的来源关系） */
  entityIds: Cid[];
}

export interface ProjectMeta {
  projectId: Cid;
  name: string;
  createdAt: number;
  algorithmVersion: string;
}
