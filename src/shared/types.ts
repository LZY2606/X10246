// ---------------------------------------------------------------------------
// 领域词汇：数据契约直接使用光学干涉/相位展开/标定自己的术语。
// ---------------------------------------------------------------------------

export type Unit = 'rad' | 'nm' | 'mm' | 'deg' | 'dB' | 'count' | '1';

/** 带单位与坐标基准的量。frame 指明坐标基准（如 sensor-pixel / optical-flat-01）。 */
export interface Qty {
  value: number;
  unit: Unit;
  frame?: string;
}

export interface GridSpec {
  rows: number;
  cols: number;
  /** 像素间距，携带单位与坐标基准。 */
  spacing: Qty;
  frame: string;
}

/** 行优先标量场；null 表示该位置无数据（导入时保留原表示）。 */
export interface ScalarField {
  grid: GridSpec;
  unit: Unit;
  values: (number | null)[];
}

export type Pixel = [row: number, col: number];

export interface Diagnostic {
  code: string;
  message: string;
  at?: Pixel;
  raw?: unknown;
}

// --- 输入实体（原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史） ---

export type InputKind =
  | 'WrappedPhaseField'
  | 'QualityScoreField'
  | 'InvalidMask'
  | 'WavelengthSpec'
  | 'IncidenceGeometry'
  | 'CalibrationPlane'
  | 'CutEditHistory';

export const INPUT_KINDS: InputKind[] = [
  'WrappedPhaseField',
  'QualityScoreField',
  'InvalidMask',
  'WavelengthSpec',
  'IncidenceGeometry',
  'CalibrationPlane',
  'CutEditHistory',
];

export interface WrappedPhaseField {
  kind: 'WrappedPhaseField';
  field: ScalarField; // unit: 'rad'，取值 [-π, π)
  raw: string; // 导入时的原始表示，原样保留
}

export interface QualityScoreField {
  kind: 'QualityScoreField';
  field: ScalarField; // unit: 'dB'
  thresholdDb: number; // 低于该信噪评分的像素不得猜相位
}

export interface InvalidMask {
  kind: 'InvalidMask';
  grid: GridSpec;
  invalid: number[]; // 0/1，行优先
}

export interface WavelengthSpec {
  kind: 'WavelengthSpec';
  wavelength: Qty; // nm
  source: string; // 标定来源说明
}

export interface IncidenceGeometry {
  kind: 'IncidenceGeometry';
  angleOfIncidence: Qty; // deg
  mode: 'reflection' | 'transmission';
  axisFrame: string;
}

export interface CalibrationPlane {
  kind: 'CalibrationPlane';
  planeZ: Qty; // mm
  datum: string | null; // 为 null 时绝对整周数无法唯一确定
  referenceFrames: string[];
}

export interface CutEdit {
  op: 'add' | 'remove';
  edge: [Pixel, Pixel];
  reason: string;
}

export interface CutEditHistory {
  kind: 'CutEditHistory';
  edits: CutEdit[];
}

// --- 派生实体 ---

export type DerivedKind =
  | 'QualityMap'
  | 'ResidueMap'
  | 'CutNetwork'
  | 'UnwrapCandidate'
  | 'HeightMap';

export type PixelState = 'valid' | 'invalid' | 'unknown';

export interface QualityMap {
  kind: 'QualityMap';
  grid: GridSpec;
  state: PixelState[]; // 行优先；unknown = 低振幅区域，不得猜相位
  diagnostics: Diagnostic[];
}

export interface ResidueMap {
  kind: 'ResidueMap';
  grid: GridSpec;
  plaquettes: { at: Pixel; residue: number }[]; // 非零残差（单位：整周）
  skipped: { at: Pixel; reason: string }[];
}

export interface CutNetwork {
  kind: 'CutNetwork';
  grid: GridSpec;
  edges: { a: Pixel; b: Pixel; origin: 'auto' | 'manual' }[];
}

export interface CutCrossing {
  edge: [Pixel, Pixel];
  /** 切口两侧的整周偏移，显式表示。 */
  offsetCycles: number;
}

export interface UnwrapCandidate {
  kind: 'UnwrapCandidate';
  grid: GridSpec;
  tree: string; // 展开树标识（种子与遍历顺序）
  seed: Pixel;
  globalShift: number; // 整周多解：整体 2πk 平移
  k: (number | null)[]; // 每像素整周数；null = 未知（不猜）
  path: { pixel: Pixel; parent: Pixel | null }[]; // 展开路径
  cutCrossings: CutCrossing[];
  cycleResiduals: { at: Pixel; residual: number }[]; // 循环残差（单位：整周）
  unknowns: Pixel[]; // 低振幅/无效区域
  components: number; // 连通分量数
}

export interface HeightMap {
  kind: 'HeightMap';
  grid: GridSpec;
  unit: 'mm';
  values: (number | null)[];
  chain: {
    candidate: Ref;
    wavelength: Ref;
    geometry: Ref;
    calibration: Ref;
  };
}

// --- 复核实体 ---

export interface LocalLock {
  kind: 'LocalLock';
  region: Pixel[];
  cutEdge: [Pixel, Pixel];
  offsetCycles: number;
  candidate: Ref;
  rationale: string;
}

// --- 引用与版本 ---

export interface Ref {
  entityId: string;
  versionNo: number;
  digest: string;
}

export interface Sourced {
  sources: Ref[];
  algoVersion: string;
  paramFingerprint: string;
}

export type EntityKind = InputKind | DerivedKind | 'LocalLock';

// --- 事件（机器可读取的判断依据） ---

export type EventType =
  | 'input.imported'
  | 'input.revised'
  | 'baseline.frozen'
  | 'derived.computed'
  | 'result.staled'
  | 'scenario.triggered'
  | 'scenario.judged'
  | 'candidate.generated'
  | 'candidate.adopted'
  | 'candidate.rejected'
  | 'lock.created'
  | 'lock.conflict.detected'
  | 'lock.conflict.resolved'
  | 'decision.undone'
  | 'export.created'
  | 'archive.imported'
  | 'corruption.detected';

export interface DomainEvent {
  id: string;
  seq: number;
  at: string;
  type: EventType;
  actor: string;
  payload: Record<string, unknown>;
}
