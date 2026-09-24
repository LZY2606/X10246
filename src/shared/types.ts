/**
 * 领域数据契约：直接使用光学干涉/相位展开/标定词汇，不压成 name/value。
 * 所有领域量携带单位或坐标基准；原始表示在导入层保留，派生层才规范化。
 */

export type Unit =
  | 'rad' // 相位（弧度）
  | 'cycle' // 整周数（2π 为单位）
  | 'nm' | 'um' | 'mm' | 'm' // 长度
  | 'count' // 探测器计数（振幅原始表示）
  | 'px' // 像素
  | 'deg' | 'dimensionless';

/** 坐标基准：sensor-pixel = 探测器像素坐标；lab-xyz = 实验室坐标系 */
export type Frame = 'sensor-pixel' | 'lab-xyz' | 'optical-axis';

export interface Quantity<V> {
  value: V;
  unit: Unit;
  frame: Frame;
}

export interface GridSpec {
  width: number;
  height: number;
  pixelPitch: Quantity<number>; // 像素间距
}

/** 输入实体种类：七种不可覆盖输入 */
export type InputKind =
  | 'wrapped-phase' // 原相位像素（包裹相位）
  | 'snr-amplitude' // 信噪评分 / 振幅
  | 'invalid-mask' // 无效遮罩
  | 'wavelength' // 波长
  | 'incident-geometry' // 入射几何
  | 'calibration-plane' // 标定面
  | 'cut-edit-history'; // 切口编辑历史

export const INPUT_KINDS: InputKind[] = [
  'wrapped-phase', 'snr-amplitude', 'invalid-mask',
  'wavelength', 'incident-geometry', 'calibration-plane', 'cut-edit-history',
];

export interface WrappedPhaseField {
  kind: 'wrapped-phase';
  grid: GridSpec;
  /** 包裹相位，rad，(-π, π]；原始表示原样保留 */
  phase: Quantity<Float64Array | number[]>;
  rawEncoding: string; // 例如 'float32-le/rad'，导入时保留原始表示
}

export interface SnrAmplitudeMap {
  kind: 'snr-amplitude';
  grid: GridSpec;
  amplitude: Quantity<Float64Array | number[]>; // count
  snrScore: Quantity<Float64Array | number[]>; // dimensionless 0..1
}

export interface InvalidMask {
  kind: 'invalid-mask';
  grid: GridSpec;
  /** 1 = 无效（不可用），0 = 有效 */
  invalid: (0 | 1)[];
}

export interface WavelengthSpec {
  kind: 'wavelength';
  wavelength: Quantity<number>; // nm
  source: string; // 例如 'HeNe 激光器铭牌'
}

export interface IncidentGeometry {
  kind: 'incident-geometry';
  mode: 'reflection' | 'transmission';
  incidenceAngle: Quantity<number>; // deg，相对法线
}

export interface CalibrationPlane {
  kind: 'calibration-plane';
  /** z(x,y) = a*x + b*y + c，单位 um，lab-xyz */
  coefficients: { a: number; b: number; c: number };
  unit: 'um';
  frame: 'lab-xyz';
}

export interface CutEdit {
  seq: number;
  action: 'add-cut' | 'remove-cut';
  /** 像素邻接边 "x,y-x2,y2" */
  edge: string;
  actor: string;
}

export interface CutEditHistory {
  kind: 'cut-edit-history';
  edits: CutEdit[];
}

export type InputPayload =
  | WrappedPhaseField | SnrAmplitudeMap | InvalidMask
  | WavelengthSpec | IncidentGeometry | CalibrationPlane | CutEditHistory;

/** 输入版本记录（持久层行） */
export interface InputVersion {
  id: string; // 稳定身份，例如 in_wavelength_v2
  projectId: string;
  setId: string; // 输入集合：baseline / case:<scenario>:minimal / case:<scenario>:combined ...
  kind: InputKind;
  version: number;
  parentId: string | null; // 修订父版本
  blobHash: string; // 内容寻址，共享原始片段只存一份
  scope: BBox | null; // 本次版本影响的局部范围；null = 全幅
  meta: Record<string, unknown>;
  createdSeq: number;
}

export interface BBox { x0: number; y0: number; x1: number; y1: number }

export type ResultStatus = 'current' | 'stale' | 'adopted' | 'rejected' | 'superseded';

export interface DerivedResult {
  id: string;
  projectId: string;
  setId: string;
  kind: 'unwrap-run' | 'solution-candidate' | 'height-chain';
  algoVersion: string; // 算法版本
  paramFingerprint: string; // 参数指纹
  sourceRefs: string[]; // 直接来源（输入版本 id / 上游结果 id）
  scope: BBox | null;
  status: ResultStatus;
  payload: unknown;
  createdSeq: number;
}

export interface Diagnostic {
  code: string; // 例如 'low-amplitude-no-guess' / 'unit-unconvertible' / 'cycle-non-closure'
  message: string;
  where: BBox | { pixel: [number, number] } | null;
  severity: 'info' | 'warning' | 'error';
}

/** 机器可读取事件：判断依据落库 */
export interface DomainEvent {
  seq: number;
  id: string;
  projectId: string;
  type: EventType;
  at: string; // 虚拟时间 ISO
  actor: string;
  payload: Record<string, unknown>;
  refs: { inputs?: string[]; results?: string[]; decisions?: string[] };
}

export type EventType =
  | 'project.created'
  | 'input.imported'
  | 'input.revised' // 新版本 + 父版本关系，旧版本不可覆盖
  | 'input.overwrite-rejected' // 试图覆盖不可变输入被拒绝
  | 'baseline.locked'
  | 'unwrap.requested'
  | 'region.unknown-marked' // 低振幅区域不得猜相位
  | 'cut.offset-declared' // 切口两侧整周偏移显式表示
  | 'cycle.residual-recorded' // 保留路径与循环残差
  | 'candidate.generated'
  | 'candidate.rejected'
  | 'candidate.adopted'
  | 'solution.locked' // 锁定局部解
  | 'lock.conflict' // 局部锁定冲突
  | 'decision.made' // 接受 / 否定 / 参数调整
  | 'decision.undone'
  | 'result.staled' // 局部输入变化使依赖结果过期
  | 'diagnostic.raised'
  | 'export.created'
  | 'import.completed';

export interface Decision {
  id: string;
  projectId: string;
  eventSeq: number;
  action: 'accept' | 'reject' | 'adjust-params' | 'lock' | 'unlock' | 'resolve-conflict';
  target: string; // 结果 / 候选 / 锁 id
  rationale: string;
  payload: Record<string, unknown>;
  supersedes: string | null;
  undone: boolean;
}

export interface LocalLock {
  id: string;
  projectId: string;
  componentId: string;
  kOffset: number; // 锁定的整周偏移
  status: 'active' | 'conflicted' | 'resolved' | 'undone';
  actor: string;
  eventSeq: number;
}
