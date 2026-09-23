// 领域词汇：光学干涉 / 相位展开 / 标定
export type RawInputKind =
  | 'wrapped_phase'       // 原相位像素（包裹相位）
  | 'snr_score'           // 信噪评分
  | 'invalid_mask'        // 无效遮罩
  | 'wavelength'          // 波长
  | 'incidence_geometry'  // 入射几何
  | 'calibration_surface' // 标定面
  | 'cut_edit_history';   // 切口编辑历史

export const RAW_INPUT_KINDS: RawInputKind[] = [
  'wrapped_phase', 'snr_score', 'invalid_mask',
  'wavelength', 'incidence_geometry', 'calibration_surface', 'cut_edit_history',
];

export type ScenarioKind =
  | 'phase_boundary'        // 相位跨越边界
  | 'low_amplitude_hole'    // 低振幅孔洞
  | 'multi_component'       // 多连通区
  | 'cycle_inconsistency'   // 循环不闭合
  | 'wavelength_version'    // 波长版本变更
  | 'integer_ambiguity'     // 整周多解
  | 'lock_conflict';        // 局部锁定冲突

export const SCENARIO_KINDS: ScenarioKind[] = [
  'phase_boundary', 'low_amplitude_hole', 'multi_component',
  'cycle_inconsistency', 'wavelength_version', 'integer_ambiguity', 'lock_conflict',
];

// 所有领域量都携带单位或坐标基准
export interface Quantity<T> {
  value: T;
  unit: string;   // 'rad' | 'nm' | 'mm' | 'deg' | '1' | 'count'
  frame: string;  // 坐标基准，如 'sensor-pixel' | 'sample-xyz' | 'optical-axis'
}

export interface Grid {
  width: number;
  height: number;
  values: (number | null)[]; // row-major；null = 原始无效位置
}

export interface GridQuantity extends Quantity<Grid> {}

export interface WavelengthQuantity extends Quantity<number> {} // nm
export interface IncidenceGeometry extends Quantity<{
  thetaDeg: number;       // 入射角
  azimuthDeg: number;
  doublePass: boolean;    // 反射式双程
}> {}
export interface CalibrationSurface extends Quantity<{
  referenceFlatNm: number;
  tiltXNmPerPx: number;
  tiltYNmPerPx: number;
}> {}
export interface CutEditRecord {
  op: 'add_cut' | 'remove_cut';
  edge: CutEdge;
  editor: string;
  note?: string;
}
export interface CutEditHistory extends Quantity<CutEditRecord[]> {}

export interface CutEdge { x: number; y: number; dir: 'h' | 'v' } // 像素 (x,y) 与 (x+1,y) 或 (x,y+1) 之间

export type PixelState = 'unwrapped' | 'unknown_low_amplitude' | 'unknown_isolated' | 'masked';

export interface UnwrappedPixel {
  value: number | null;   // rad，未知为 null
  state: PixelState;
  parent: number | null;  // 展开树父像素索引（路径回溯）
}

export interface CycleResidual {
  loop: [number, number][]; // 像素坐标闭环
  residualCycles: number;   // 以 2π 为单位的残差
}

export interface CutOffset {
  edge: CutEdge;
  k: number;                // 切口两侧显式整周偏移
  consistent: boolean;
}

export interface UnwrapCandidatePayload {
  componentId: number;
  seedPixel: [number, number];
  seedStrategy: string;
  pixels: UnwrappedPixel[];
  cutOffsets: CutOffset[];
  cycleResiduals: CycleResidual[];
  unknownCount: number;
  meanQuality: number;
}

export interface HeightChainStep {
  step: 'unwrapped_phase' | 'opd' | 'height';
  unit: string;
  frame: string;
  algoVersion: string;
  paramFingerprint: string;
  sourceRefs: { role: string; sourceVersionId: string; contentHash: string }[];
}

export type CandidateState = 'proposed' | 'accepted' | 'rejected' | 'unknown';

export type DecisionKind =
  | 'accept' | 'reject' | 'param_adjust'
  | 'lock' | 'unlock' | 'conflict_resolve' | 'undo';

// 机器可读取的判断依据
export interface Judgment {
  rule:
    | 'low_amplitude_no_guess'        // 低振幅区域不得猜相位
    | 'cut_offset_explicit'           // 切口两侧的整周偏移要显式表示
    | 'multi_tree_local_consistency'  // 不同展开树可得到局部一致解，需保留路径与循环残差
    | 'raw_inputs_immutable'          // 原始输入不可覆盖
    | 'stale_not_current'             // 过期结果不能冒充当前结果
    | 'missing_reference_corruption'; // 缺少引用必须报损坏
  detail: Record<string, unknown>;
}

export interface EventRecord {
  seq: number;
  id: string;
  ts: string;
  type: string;
  entityKind: string | null;
  entityId: string | null;
  judgment: Judgment[] | null;
  payload: Record<string, unknown>;
}

export class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export class DomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'DomainError';
  }
}
