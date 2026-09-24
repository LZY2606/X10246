// 干涉条纹簿 —— 共享领域词汇
// 规则：原始输入实体一经提交不可覆盖；修订通过“新版本 + 父版本”表达。
// 派生实体必须带算法版本、参数指纹与直接来源。

export type Unit = string;

export interface Dim {
  rows: number;
  cols: number;
}

export interface CoordBasis {
  // 坐标基准：像素原点位于左上角，x 向右（列），y 向下（行）
  origin: 'top-left';
  axes: ['col', 'row'];
  pixelPitchX: number; // 米/像素
  pixelPitchY: number;
  lengthUnit: 'm';
}

export type EntityKind =
  | 'wrappedPhase'
  | 'amplitude'
  | 'qualityScore'
  | 'invalidMask'
  | 'wavelength'
  | 'incidenceGeometry'
  | 'calibrationPlane'
  | 'cutEditHistory'
  | 'qualityMap'
  | 'cutNetwork'
  | 'unwrappedField'
  | 'heightField';

export interface Ref {
  kind: EntityKind;
  lineage: string; // 来源血缘标识（raw_input/修订链）
  version: number; // 必须显式，缺失即损坏
}

export interface Provenance {
  algorithmVersion?: string; // 例：unwrap/1.0.0
  paramFingerprint?: string; // 参数指纹（内容寻址）
  directSources: Ref[]; // 直接来源（非传递性摘要）
  parentVersion?: number; // 同一血缘的父版本
}

// 存储实体：身份 = (kind, lineage)；内容版本由 hash 标识。
export interface StoredEntity<T = unknown> {
  kind: EntityKind;
  lineage: string;
  version: number;
  contentHash: string;
  createdAt: number;
  provenance: Provenance;
  content: T;
}

export interface EntitySummary {
  kind: EntityKind;
  lineage: string;
  version: number;
  contentHash: string;
  createdAt: number;
  parentVersion?: number;
  contentDigest: string; // 内容摘要（领域关键字段，不只是原始 JSON）
}

export interface EntityEnvelope<T = unknown> {
  entity: StoredEntity<T>;
  referenced: EntitySummary[]; // 引用实体的版本号与内容摘要
  current: boolean; // false = 已过期（仍可查看，不能冒充当前）
  supersededBy?: string; // lineage:version
  corruption?: CorruptionReport[]; // 缺少引用/引用版本不存在 -> 损坏
}

export interface CorruptionReport {
  code: 'MISSING_REFERENCE' | 'MISSING_VERSION' | 'CONTENT_MISMATCH' | 'UNKNOWN_KIND';
  ref: Ref;
  message: string;
}

// ---------- 原始输入实体 ----------

export interface WrappedPhaseContent {
  dim: Dim;
  basis: CoordBasis;
  // 弧度，范围 (-pi, pi]；null = 原像素缺失（保留原始表示，不猜）
  radians: (number | null)[];
  phaseUnit: 'rad';
}

export interface AmplitudeContent {
  dim: Dim;
  counts: number[]; // 原始计数表示，保留原值
  countsUnit: string; // 例：adu
}

export interface QualityScoreContent {
  dim: Dim;
  score: number[]; // 0..1 信噪评分
  method: string;
}

export interface InvalidMaskContent {
  dim: Dim;
  invalid: boolean[];
  reason: (string | null)[]; // 每个无效像素的原始原因（导入时保留）
}

export interface WavelengthContent {
  value: number; // 米
  unit: 'm';
  source: string; // 例：laser-serial-IFB-633
  revisionNote?: string;
}

export interface IncidenceGeometryContent {
  // 照明与观察方向的单位向量（实验室基准），夹角编码在 sensitivity 中
  illumination: { x: number; y: number; z: number };
  observation: { x: number; y: number; z: number };
  basis: 'lab-right-handed';
  angleDeg: number | null; // 无法转换则为 null 并附诊断
  diagnostics: string[];
}

export interface CalibrationPlaneContent {
  // 标定面：高度 = a*x + b*y + c（米），带拟合诊断
  samples: { x: number; y: number; z: number }[];
  fit: { a: number | null; b: number | null; c: number | null; rmse: number | null };
  diagnostics: string[];
  lengthUnit: 'm';
}

export interface CutEdit {
  editId: string;
  at: number; // 虚拟时钟毫秒
  action:
    | { type: 'add-cut'; between: [number, number]; reason: string }
    | { type: 'remove-cut'; between: [number, number]; reason: string }
    | { type: 'anchor-boundary'; pixel: number; boundary: 'outer' | 'hole'; reason: string };
  by: string;
}

export interface CutEditHistoryContent {
  dim: Dim;
  edits: CutEdit[];
}

// ---------- 派生实体 ----------

export interface QualityMapCell {
  px: number;
  valid: boolean;
  amplitude: number | null;
  snr: number | null;
  lowAmplitude: boolean; // 低振幅 -> 不猜相位
}

export interface QualityMapContent {
  dim: Dim;
  cells: QualityMapCell[];
  threshold: { amplitudeFloor: number; snrFloor: number };
}

export type EdgeDir = 'h' | 'v';

export interface CutEdge {
  edgeId: string; // 稳定身份：e:h:r:c
  a: number; // 像素索引
  b: number;
  dir: EdgeDir;
  wrapDiff: number; // wrap(phi_b - phi_a)，弧度
  source: 'residue-pair' | 'boundary-anchor' | 'manual';
  weight: number;
}

export interface Residue {
  px: number;
  charge: 1 | -1; // 逆时针 2x2 闭合环绕和 / 2pi
}

export interface CutNetworkContent {
  dim: Dim;
  residues: Residue[];
  cuts: CutEdge[];
  components: { compId: string; pixels: number[] }[]; // 切口切出的区域
  regions: { regionId: string; pixelCount: number }[];
}

export interface CycleCandidate {
  k: number; // 整周偏移（2pi*k 加到 b 相对 a）
  legal: boolean;
  rejectReason?:
    | 'fringe-order-limit'
    | 'amplitude-floor'
    | 'already-equivalent'
    | 'manual-lock-conflict';
}

export interface CycleResidual {
  cycleId: string; // c:<pixels joined ->
  pixels: number[]; // 闭合路径（首尾相同）
  wrapSumRad: number;
  residualCycles: number; // wrapSum / 2pi，0 为闭合
  closed: boolean;
  edgeKs: Record<string, number>; // 该循环使用的各边整周
  diagnostic?: string;
}

export interface UnwrapSolution {
  solutionId: string; // sol:tree1 / sol:tree2 / sol:lock...
  treeStrategy: string;
  treePath: { edgeId: string; from: number; to: number; k: number }[]; // 展开树路径
  field: (number | null)[]; // 弧度；低振幅/遮罩像素为 null（不猜）
  anchoredPixel: number;
  anchorValue: number;
  cycleResiduals: CycleResidual[];
  accepted: boolean;
  rejectReason?: string;
}

export interface EdgeKRecord {
  edgeId: string;
  between: [number, number];
  wrapDiff: number;
  candidates: CycleCandidate[]; // 全部合法候选 + 被拒候选
  chosenK?: number;
  ambiguity: boolean; // 是否存在多解
}

export interface UnwrappedFieldContent {
  dim: Dim;
  solutions: UnwrapSolution[];
  currentSolutionId: string;
  edgeKs: EdgeKRecord[];
  diagnostics: string[]; // 循环不闭合等诊断
}

export interface HeightCell {
  px: number;
  unwrappedRad: number | null;
  heightM: number | null; // 无法转换则 null
  diagnostic?: string;
}

export interface HeightFieldContent {
  dim: Dim;
  sensitivityRadPerM: number | null;
  heightPerRadM: number | null;
  calibrationResidualRmse: number | null;
  cells: HeightCell[];
  diagnostics: string[];
}

// ---------- 事件（机器可读的判断依据）----------

export type RationaleCode =
  | 'LOW_AMPLITUDE_NO_GUESS'
  | 'CUT_INTEGER_OFFSET_EXPLICIT'
  | 'TREE_LOCALLY_CONSISTENT_KEEP_PATH_RESIDUAL'
  | 'MULTIPLE_LEGAL_SOLUTIONS'
  | 'CYCLE_NOT_CLOSED'
  | 'WAVELENGTH_VERSION_CHANGED'
  | 'LOCAL_LOCK_CONFLICT'
  | 'PHASE_BOUNDARY_WRAP'
  | 'MULTIPLY_CONNECTED_REGION'
  | 'SOURCE_REVISION_LOCAL_EXPIRY'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'PARAM_ADJUSTED';

export interface FringeEvent {
  seq: number;
  at: number; // 虚拟时钟
  type:
    | 'import'
    | 'param-revision'
    | 'source-revision'
    | 'derive'
    | 'decision'
    | 'lock'
    | 'unlock'
    | 'lock-conflict'
    | 'replay-marker'
    | 'export'
    | 'import-archive';
  rationaleCodes: RationaleCode[];
  subject?: Ref;
  payload: Record<string, unknown>;
  prevEventHash: string | null;
  eventHash: string;
}
