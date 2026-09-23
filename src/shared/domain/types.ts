/**
 * 干涉条纹簿领域词汇表。
 *
 * 这里不使用通用的 name/value 压缩形式；每个实体都用光学干涉 / 相位展开 /
 * 标定自身的概念命名。所有领域量携带单位或坐标基准，导入时保留原始表示，
 * 派生层才做规范化；无法转换的值留在原位置并附诊断。
 */

export type RawSlot =
  | 'wrapped_phase'
  | 'signal_quality'
  | 'invalid_mask'
  | 'wavelength'
  | 'illumination_geometry'
  | 'calibration_plane'
  | 'cut_edit_history';

export type EntityKind =
  | `raw_${RawSlot}`
  | 'quality_map'
  | 'residue_map'
  | 'cut_network'
  | 'unwrap_tree'
  | 'integer_candidate_set'
  | 'cycle_residual'
  | 'height_field'
  | 'review_lock'
  | 'decision_record';

/** 携带原始表示的领域量：raw 永不被规范化覆盖。 */
export interface DomainQuantity {
  raw: string;
  value: number | null;
  unit: string;
  diagnostic?: string;
}

export interface Vec2 {
  x: DomainQuantity;
  y: DomainQuantity;
}

/** 像素网格的坐标基准。 */
export interface GridDatum {
  width: number;
  height: number;
  origin: Vec2;
  pixelPitch: Vec2;
}

export type Pixel = number; // 行优先索引 y*width+x

/* ------------------------------ 不可变输入实体 ------------------------------ */

export interface WrappedPhaseFrame {
  grid: GridDatum;
  /** 包裹相位（弧度），约定区间 [-pi, pi)；无法解析的像素为 null，绝不猜值。 */
  phase: (number | null)[];
  phaseUnit: 'rad';
  rangeConvention: '[-pi,pi)';
  /** 逐像素解析诊断（例如非数值、越界值留在原位置）。 */
  cellDiagnostics: { pixel: Pixel; raw: string; diagnostic: string }[];
  sourceLabel: string;
}

export interface SignalQualityFrame {
  grid: GridDatum;
  amplitude: (number | null)[];
  amplitudeUnit: string;
  snrDb: (number | null)[];
  snrUnit: 'dB';
  sourceLabel: string;
}

export interface InvalidMaskFrame {
  grid: GridDatum;
  /** true = 无效像素（低振幅孔洞、遮挡等），展开时禁止猜相位。 */
  invalid: boolean[];
  reasons: { pixels: Pixel[]; reason: string }[];
  sourceLabel: string;
}

export interface WavelengthSpec {
  lambda: DomainQuantity;
  medium: string;
  note: string;
}

export interface IlluminationGeometry {
  incidenceAngle: DomainQuantity; // 入射角（度，相对表面法线）
  observationAngle: DomainQuantity; // 观察角（度，相对表面法线）
  /** 入射/观察方向单位向量，坐标基准由 coordinateFrame 声明。 */
  incidentVector: { x: number; y: number; z: number };
  observationVector: { x: number; y: number; z: number };
  coordinateFrame: string;
}

export interface CalibrationPlane {
  coordinateFrame: string;
  /** 标定面 z = a*x + b*y + c（标定坐标基准）。 */
  a: DomainQuantity;
  b: DomainQuantity;
  c: DomainQuantity;
  anchorPixels: Pixel[];
  referenceHeight: DomainQuantity;
  rmsResidual: DomainQuantity;
  sourceFrameLabel: string;
}

export interface CutEdit {
  editId: string;
  action: 'add' | 'remove';
  a: Pixel;
  b: Pixel;
  reason: string;
  author: string;
}

export interface CutEditHistory {
  /** 仅追加的切口编辑链；任何修改都产生新版本，绝不覆盖。 */
  edits: CutEdit[];
}

/* -------------------------------- 派生实体 -------------------------------- */

export interface QualityMap {
  grid: GridDatum;
  quality: number[];
  formula: string;
  thresholds: { minAmplitude: number; minSnrDb: number };
}

export interface ResidueInfo {
  i: number;
  j: number;
  plaquette: number;
  charge: -1 | 0 | 1;
}

export interface ResidueMap {
  grid: GridDatum;
  /** 每个小面元的绕转电荷 -1/0/+1；被遮罩的小面元为 null。 */
  charges: (-1 | 0 | 1 | null)[];
  residues: ResidueInfo[];
}

export interface CutEdge {
  cutEdgeId: string;
  a: Pixel;
  b: Pixel;
  /** 切口两侧的整周偏移 k_b - k_a，必须显式表示。 */
  jump: number;
  source: 'residue-pairing' | 'manual' | 'to-border';
  weight: number;
}

export interface CutNetwork {
  grid: GridDatum;
  cuts: CutEdge[];
  pairingLog: string[];
}

export interface TreeEdge {
  u: Pixel;
  v: Pixel;
  /** 沿该边累计整周数的增量 k_v - k_u（由包裹差与原始差判定）。 */
  step: number;
}

export interface UnwrapTree {
  treeId: string;
  algorithm: string;
  algoVersion: string;
  root: Pixel;
  /** 以根为起点的积分路径顺序，保留路径以便复查。 */
  pathOrder: Pixel[];
  edges: TreeEdge[];
  componentId: number;
}

export type CandidateStatus = 'legal' | 'accepted' | 'rejected' | 'unknown';

export interface IntegerCandidate {
  candidateId: string;
  treeId: string;
  /** 每像素整周数 k；无效像素为 null。 */
  k: (number | null)[];
  globalOffset: number;
  componentOffsets: Record<string, number>;
  status: CandidateStatus;
  score: number;
  rejectReason?: string;
  ambiguityNote?: string;
}

export interface IntegerCandidateSet {
  grid: GridDatum;
  anchor: Pixel | null;
  candidates: IntegerCandidate[];
  ambiguity: 'none' | 'global-fringe' | 'relative-component';
}

export interface CycleCheck {
  cycleId: string;
  kind: 'plaquette' | 'graph-cycle';
  pixels: Pixel[];
  /** 绕环一周的相位残差（弧度）；闭合良好时为 0。 */
  residualRad: number;
  charge: number;
  closed: boolean;
  note?: string;
}

export interface CycleResidualReport {
  grid: GridDatum;
  cycles: CycleCheck[];
  openCycleCount: number;
}

export interface HeightPixelChain {
  pixel: Pixel;
  wrappedRad: number | null;
  k: number | null;
  unwrappedRad: number | null;
  fringeOrder: number | null;
  sensitivityFactor: number | null;
  relativeHeight: number | null;
  planeAdjustment: number | null;
  calibratedHeight: number | null;
  unit: string;
}

export interface HeightField {
  grid: GridDatum;
  formula: string;
  sensitivityFactor: DomainQuantity;
  wavelengthValue: number | null;
  geometryAngles: { incidenceDeg: number | null; observationDeg: number | null };
  chains: HeightPixelChain[];
  rmsResidual: DomainQuantity;
}

export interface ReviewLock {
  lockId: string;
  pixels: Pixel[];
  candidateId: string | null;
  lockedValue: string;
  interpretation: string;
  status: 'active' | 'conflict' | 'released';
}

/* -------------------------------- 实体信封 -------------------------------- */

export interface EntityRef {
  entityId: string;
  version: number;
  kind: EntityKind;
  summary: string;
}

export interface Provenance {
  algoVersion?: string;
  paramsFingerprint?: string;
  seed?: number;
}

export interface EntityEnvelope<T = unknown> {
  entityId: string;
  kind: EntityKind;
  caseId: string;
  slot?: RawSlot;
  version: number;
  parentId: string | null;
  blobHash: string;
  /** 直接来源引用；查询实体时一并返回，缺少任何引用即判损坏。 */
  refs: EntityRef[];
  provenance?: Provenance;
  createdAt: { iso: string; tick: number };
  data: T;
}

/* --------------------------------- 事件 --------------------------------- */

export type LedgerEventType =
  | 'raw_committed'
  | 'raw_revision_blocked'
  | 'derived_committed'
  | 'candidate_ruled'
  | 'cut_edited'
  | 'lock_acquired'
  | 'lock_conflict'
  | 'lock_released'
  | 'decision_recorded'
  | 'decision_undone'
  | 'case_opened'
  | 'archive_imported';

export interface LedgerEvent {
  eventId: string;
  seq: number;
  caseId: string;
  at: { iso: string; tick: number };
  type: LedgerEventType;
  payload: Record<string, unknown>;
}

/** 反例情形标识：七种核心检验。 */
export type CounterexampleKind =
  | 'phase-boundary'
  | 'low-amplitude-hole'
  | 'multi-connected'
  | 'cycle-nonclosure'
  | 'wavelength-revision'
  | 'integer-ambiguity'
  | 'lock-conflict';

export interface ImportDiagnostic {
  code: string;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}
