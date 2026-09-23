/**
 * 数据契约：直接使用光学干涉/相位展开/标定领域词汇。
 * 所有领域量携带单位或坐标基准；原始表示在导入层保留，派生层才做规范化。
 */

// ---------- 通用 ----------
export type EntityId = string;

export interface SourceRef {
  /** 引用的实体 id */
  id: EntityId;
  /** 钉住的版本号；查询时若该版本缺失必须报损坏，不得退回最新版 */
  version: number;
}

export interface Grid {
  width: number;
  height: number;
  /** 行主序数值；单位与坐标基准随实体类型而定 */
  values: number[];
}

export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------- 输入实体（不可覆盖；修订 = 新版本 + 父版本关系） ----------
export type InputKind =
  | 'wrapped_phase' // 原相位像素（包裹相位，rad）
  | 'snr_score' // 信噪评分
  | 'invalid_mask' // 无效遮罩
  | 'wavelength' // 波长
  | 'incidence_geometry' // 入射几何
  | 'calibration_surface' // 标定面
  | 'cut_edit_history'; // 切口编辑历史

export const INPUT_KINDS: InputKind[] = [
  'wrapped_phase',
  'snr_score',
  'invalid_mask',
  'wavelength',
  'incidence_geometry',
  'calibration_surface',
  'cut_edit_history',
];

export interface WrappedPhaseInput {
  kind: 'wrapped_phase';
  grid: Grid; // unit: 'rad', basis: 'detector-pixel'
  unit: 'rad';
  basis: 'detector-pixel';
  rawRepresentation: string; // 导入时的原始表示（如 16 位整型计数说明）
}

export interface SnrScoreInput {
  kind: 'snr_score';
  grid: Grid; // unit: 'dB'
  unit: 'dB';
  basis: 'detector-pixel';
}

export interface InvalidMaskInput {
  kind: 'invalid_mask';
  width: number;
  height: number;
  /** true = 无效像素 */
  invalid: boolean[];
  basis: 'detector-pixel';
}

export interface WavelengthInput {
  kind: 'wavelength';
  value: number;
  unit: 'nm';
  source: string; // 例如 'HeNe 激光器规格书'
}

export interface IncidenceGeometryInput {
  kind: 'incidence_geometry';
  thetaDeg: number; // 入射角
  unit: 'deg';
  basis: 'optical-table';
  baselineMm: number;
}

export interface CalibrationSurfaceInput {
  kind: 'calibration_surface';
  grid: Grid; // unit: 'rad'（标定帧的包裹相位）
  unit: 'rad';
  basis: 'detector-pixel';
  referencePlane: string; // 坐标基准说明
}

export interface CutEdit {
  /** 像素邻接边：[像素a索引, 像素b索引] */
  edge: [number, number];
  op: 'add' | 'remove';
  author: string;
}

export interface CutEditHistoryInput {
  kind: 'cut_edit_history';
  edits: CutEdit[];
}

export type InputContent =
  | WrappedPhaseInput
  | SnrScoreInput
  | InvalidMaskInput
  | WavelengthInput
  | IncidenceGeometryInput
  | CalibrationSurfaceInput
  | CutEditHistoryInput;

export interface InputRevision {
  entityId: EntityId;
  version: number;
  parentVersion: number | null;
  kind: InputKind;
  /** 内容存于 blob 库（按哈希去重，共享原始片段只存一份） */
  blobHash: string;
  createdAt: number;
  note: string;
}

// ---------- 派生实体 ----------
export type DerivedKind =
  | 'quality_map' // 质量图
  | 'residue_map' // 残差点（偶极子）图
  | 'cut_network' // 切口网络
  | 'unwrap_candidate' // 展开候选（含路径与循环残差）
  | 'height_map'; // 高度转换链

export type DerivedStatus = 'current' | 'stale' | 'locked';

export interface DerivedRecord {
  id: EntityId;
  kind: DerivedKind;
  algoVersion: string; // 算法版本，如 'unwrap/1.0.0'
  paramFingerprint: string; // 参数指纹
  sources: SourceRef[]; // 直接来源（钉住版本）
  status: DerivedStatus;
  blobHash: string;
  createdAt: number;
  staleReason: string | null;
}

// ---------- 决定与锁定 ----------
export type DecisionType = 'accept' | 'reject' | 'adjust' | 'lock' | 'unlock' | 'revert';

export interface Decision {
  id: EntityId;
  type: DecisionType;
  targetId: EntityId; // 候选 id；revert 时为被撤销的决定/事件 id
  region: Region | null;
  rationale: string;
  params: Record<string, number> | null; // adjust 时的参数调整
  createdAt: number;
  revertedBy: EntityId | null;
}

export type LockStatus = 'active' | 'conflicted' | 'released';

export interface LocalLock {
  id: EntityId;
  region: Region;
  candidateId: EntityId;
  status: LockStatus;
  createdAt: number;
}

// ---------- 事件（机器可读取的判断依据） ----------
export type EventType =
  | 'input.imported'
  | 'input.revised'
  | 'derive.completed'
  | 'derive.failed'
  | 'rule.low_amplitude_no_guess' // 低振幅区域不得猜相位
  | 'rule.cut_offset_explicit' // 切口两侧整周偏移显式表示
  | 'rule.multi_tree_local_consistent' // 不同展开树局部一致解，保留路径与循环残差
  | 'candidate.generated'
  | 'decision.recorded'
  | 'decision.reverted'
  | 'lock.created'
  | 'lock.conflict'
  | 'derived.staled'
  | 'bundle.exported'
  | 'bundle.imported'
  | 'case.loaded';

export interface DomainEvent {
  seq: number;
  id: EntityId;
  type: EventType;
  at: number;
  payload: unknown;
}

// ---------- 规则事件载荷（判断依据，机器可读） ----------
export interface LowAmpNoGuessPayload {
  ruleId: 'LOW_AMP_NO_GUESS';
  threshold: number;
  unit: 'linear-amplitude';
  unknownPixels: number[];
  basis: 'amplitude < threshold => 相位保持未知，不做插值猜测';
}

export interface CutOffsetExplicitPayload {
  ruleId: 'CUT_OFFSET_EXPLICIT';
  offsets: { edge: [number, number]; fromComponent: number; toComponent: number; kTurns: number }[];
  basis: '切口两侧的整周偏移以显式整数 k 表示，不隐含在相位值里';
}

export interface MultiTreePayload {
  ruleId: 'MULTI_TREE_LOCAL_CONSISTENT';
  candidateId: EntityId;
  path: { from: number; to: number; kTurns: number }[];
  cycleResiduals: { cycleEdge: [number, number]; residualTurns: number }[];
  basis: '不同展开树可得到局部一致解；保留路径与循环残差供复核';
}

// ---------- 诊断 ----------
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  pixelIndex?: number;
  rawValue?: unknown; // 无法转换的值留在原位置并附诊断
}
