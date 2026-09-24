import type { Diagnostic, GridBasis, Quantity, ScalarGrid } from '../shared/units';

/** ============ 输入实体（不可覆盖，修订以新版本+父版本表达） ============ */

export type InputKind =
  | 'WrappedPhaseField' // 原相位像素（包裹相位，rad）
  | 'SnrQualityMap' // 信噪评分（0..1）
  | 'InvalidMask' // 无效遮罩（0/1）
  | 'Wavelength' // 波长
  | 'IncidenceGeometry' // 入射几何
  | 'CalibrationSurface' // 标定面
  | 'CutEditHistory'; // 切口编辑历史（只追加）

export const INPUT_KINDS: InputKind[] = [
  'WrappedPhaseField',
  'SnrQualityMap',
  'InvalidMask',
  'Wavelength',
  'IncidenceGeometry',
  'CalibrationSurface',
  'CutEditHistory',
];

export interface WrappedPhaseFieldContent {
  kind: 'WrappedPhaseField';
  label: string;
  phase: ScalarGrid; // unit 'rad'，包裹到 (-π, π]
}

export interface SnrQualityMapContent {
  kind: 'SnrQualityMap';
  label: string;
  quality: ScalarGrid; // unit '1'，0..1
}

export interface InvalidMaskContent {
  kind: 'InvalidMask';
  label: string;
  mask: ScalarGrid; // unit '1'，1=无效
}

export interface WavelengthContent {
  kind: 'Wavelength';
  label: string;
  wavelength: Quantity; // 原始单位保留（nm/A/um...）
  source: string; // 例如 'HeNe 激光器铭牌'
}

export interface IncidenceGeometryContent {
  kind: 'IncidenceGeometry';
  label: string;
  incidenceAngle: Quantity; // deg 或 rad
  mode: 'reflection' | 'transmission';
  refractiveIndex: number;
}

export interface CalibrationSurfaceContent {
  kind: 'CalibrationSurface';
  label: string;
  surface: ScalarGrid; // unit 'um'，标定面高度
  flatness: Quantity;
}

export interface CutEdit {
  editId: string;
  action: 'add-cut' | 'remove-cut';
  edge: GridEdge;
  note: string;
}

export interface CutEditHistoryContent {
  kind: 'CutEditHistory';
  label: string;
  edits: CutEdit[]; // 只追加，历史不可改
}

export type InputContent =
  | WrappedPhaseFieldContent
  | SnrQualityMapContent
  | InvalidMaskContent
  | WavelengthContent
  | IncidenceGeometryContent
  | CalibrationSurfaceContent
  | CutEditHistoryContent;

/** ============ 展开 / 决定实体 ============ */

/** 相邻像素边（无向，规范化为字典序）。 */
export interface GridEdge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface Residue {
  x: number; // 2x2 回路左上角
  y: number;
  turns: number; // 非零整数：循环不闭合量（单位：整周）
}

export interface CutOffset {
  edge: GridEdge;
  kA: number | null; // 切口两侧的整周数显式表示
  kB: number | null;
  offsetTurns: number | null; // kB-kA 的整周偏移；任一侧未知则为 null
}

export interface CycleResidual {
  x: number;
  y: number;
  residueTurns: number; // 包裹相位回路积分（整周）
  candidateLoopTurns: number; // 该候选展开后回路积分（整周）
  consistent: boolean;
}

export interface UnwrapComponent {
  componentId: number;
  pixelCount: number;
  seedPixel: { x: number; y: number };
  kShift: number; // 全局整周平移（整周多解的自由度）
}

export interface UnknownPixel {
  x: number;
  y: number;
  reason: 'low-amplitude' | 'masked'; // 低振幅区域不得猜相位
}

export interface UnwrapCandidate {
  candidateId: string;
  algorithmVersion: string; // 算法版本
  paramFingerprint: string; // 参数指纹
  sourceRefs: Record<string, string>; // 直接来源：实体 -> versionId
  strategy: string; // 展开树策略（不同展开树可得到局部一致解）
  treeId: string;
  width: number;
  height: number;
  /** 整周场：null = 未知（低振幅/遮罩），绝不猜。 */
  kField: (number | null)[];
  /** 展开树父指针（行优先索引，-1 = 根/未知）：保留路径。 */
  treeParent: number[];
  components: UnwrapComponent[];
  cutOffsets: CutOffset[];
  cycleResiduals: CycleResidual[];
  unknowns: UnknownPixel[];
  score: number;
  diagnostics: Diagnostic[];
}

export interface HeightMapContent {
  derivedId: string;
  algorithmVersion: string;
  paramFingerprint: string;
  sourceRefs: Record<string, string>; // candidate / wavelength / geometry / calibration
  heightUm: ScalarGrid; // 无法转换处为 null
  diagnostics: Diagnostic[];
}

/** ============ 复核实体 ============ */

export interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type LockStatus = 'active' | 'contested' | 'rejected' | 'undone';

export interface ReviewLock {
  lockId: string;
  candidateId: string;
  region: Region;
  status: LockStatus;
  createdSeq: number;
  note: string;
}

export interface LockConflict {
  conflictId: string;
  lockIds: string[];
  overlap: Region;
  status: 'open' | 'resolved';
  resolution?: { keepLockId: string; note: string };
}

/** ============ 事件（机器可读取的判断依据） ============ */

export type EventType =
  | 'input.imported'
  | 'input.revised'
  | 'cut.edited'
  | 'candidates.generated'
  | 'candidate.adopted'
  | 'candidate.rejected'
  | 'region.locked'
  | 'lock.conflict.detected'
  | 'lock.conflict.resolved'
  | 'decision.undone'
  | 'height.derived'
  | 'diagnostic.recorded'
  | 'casepack.loaded';

export interface DomainEvent {
  eventId: string;
  projectId: string;
  seq: number;
  type: EventType;
  at: string;
  actor: string;
  refs: Record<string, string>;
  payload: unknown;
}
