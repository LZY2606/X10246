/**
 * 领域数据契约：光学干涉 / 相位展开 / 标定。
 * 所有实体使用领域词汇命名；所有量携带单位或坐标基准。
 */

// ---------- 基础量 ----------
export type Unit =
  | 'rad'        // 相位（弧度）
  | 'nm'         // 波长
  | 'um'         // 表面高度
  | 'deg'        // 入射角
  | 'dB'         // 信噪比
  | 'count'      // 计数
  | 'pixel'      // 像素坐标
  | 'dimensionless';

export type CoordDatum =
  | 'pixel-grid'       // 探测器像素网格，原点左上，x 向右，y 向下
  | 'optical-axis'     // 以光轴为基准的角度坐标
  | 'sample-surface';  // 样品表面宏观坐标

export interface Quantity {
  value: number;
  unit: Unit;
  datum: CoordDatum;
}

export interface Grid2D {
  width: number;
  height: number;
  /** 行优先，长度 = width*height */
  values: number[];
  unit: Unit;
  datum: CoordDatum;
}

export interface MaskGrid {
  width: number;
  height: number;
  /** true = 无效像素 */
  invalid: boolean[];
  datum: CoordDatum;
}

// ---------- 输入实体（不可覆盖） ----------
export type InputKind =
  | 'wrapped_phase'        // 原相位像素（包裹相位）
  | 'snr_score'            // 信噪评分
  | 'invalid_mask'         // 无效遮罩
  | 'wavelength'           // 波长
  | 'incident_geometry'    // 入射几何
  | 'calibration_surface'  // 标定面
  | 'cut_edit_history';    // 切口编辑历史

export const INPUT_KINDS: InputKind[] = [
  'wrapped_phase', 'snr_score', 'invalid_mask', 'wavelength',
  'incident_geometry', 'calibration_surface', 'cut_edit_history',
];

export interface WrappedPhaseInput { grid: Grid2D; }
export interface SnrScoreInput { grid: Grid2D; lowAmplitudeThreshold: Quantity; }
export interface InvalidMaskInput { mask: MaskGrid; }
export interface WavelengthInput { wavelength: Quantity; source: string; }
export interface IncidentGeometryInput { incidenceAngle: Quantity; azimuth: Quantity; reflection: boolean; }
export interface CalibrationSurfaceInput { grid: Grid2D; reference: string; }
export interface CutEdit { op: 'add_cut' | 'remove_cut'; edge: EdgeRef; }
export interface CutEditHistoryInput { edits: CutEdit[]; }

export type InputPayload =
  | WrappedPhaseInput | SnrScoreInput | InvalidMaskInput | WavelengthInput
  | IncidentGeometryInput | CalibrationSurfaceInput | CutEditHistoryInput;

export interface InputVersion {
  id: string;               // 稳定身份：inp_<digest16>
  kind: InputKind;
  version: number;          // 同 kind 链上的序号，从 1 开始
  parentId: string | null;  // 修订父版本
  digest: string;           // 内容摘要 sha256
  payload: InputPayload;
  submittedAt: number;      // 虚拟时钟
  author: string;
}

// ---------- 派生计算 ----------
export type ComputationKind =
  | 'quality_map'      // 质量图（含低振幅未知态）
  | 'cut_network'      // 切口网络（残差点 + 支路切口）
  | 'unwrap_candidate' // 整周候选（一次展开树的结果）
  | 'loop_residuals'   // 循环残差
  | 'height_map';      // 高度转换链

export type ComputationStatus =
  | 'proposed'   // 候选，未裁定
  | 'adopted'    // 被采纳
  | 'rejected'   // 被拒绝（保留，不删除）
  | 'expired'    // 因来源修订而过期（仍可查看，不能冒充当前）
  | 'locked';    // 被局部锁定

export interface SourceRef {
  entity: 'input' | 'computation';
  id: string;
  version: number;   // 对 input 是版本号；对 computation 恒为 1
  digest: string;    // 引用时内容摘要，校验用
}

export interface EdgeRef { x: number; y: number; dir: 'h' | 'v'; } // 像素间边

export interface QualityMapPayload {
  grid: Grid2D;                    // 质量分 0..1
  unknownMask: boolean[];          // 低振幅/遮罩 => 不得猜相位
  threshold: Quantity;
}

export interface ResiduePoint { x: number; y: number; charge: number; }
export interface CutNetworkPayload {
  residues: ResiduePoint[];
  cutEdges: EdgeRef[];             // 支路切口（自动 + 人工编辑历史）
  manualCutEdges: EdgeRef[];
}

export interface LoopResidual {
  loopId: string;
  path: Array<{ x: number; y: number }>;
  residualCycles: number;          // 以整周为单位；非零 = 循环不闭合
}

export interface UnwrapCandidatePayload {
  seed: { x: number; y: number };
  treeOrder: string;               // 展开树描述（邻居顺序/种子策略）
  unwrapped: Grid2D;               // 未知区域为 NaN —— 低振幅不得猜相位
  integerOffsets: Array<{          // 切口两侧/多连通区的显式整周偏移
    regionId: number;
    offsetTurns: number;
    acrossCut: EdgeRef | null;
  }>;
  regionCount: number;             // 多连通区数量
  loopResiduals: LoopResidual[];
  ambiguityGroup: string | null;   // 整周多解分组
}

export interface HeightMapPayload {
  grid: Grid2D;                    // unit: um
  formula: string;                 // 高度转换链描述
  wavelength: Quantity;
  incidenceAngle: Quantity;
  unconvertible: Array<{ x: number; y: number; reason: string }>; // 留在原位并附诊断
}

export type ComputationPayload =
  | QualityMapPayload | CutNetworkPayload | UnwrapCandidatePayload
  | LoopResidual[] | HeightMapPayload;

export interface Computation {
  id: string;                      // cmp_<digest16>
  kind: ComputationKind;
  algorithmVersion: string;        // 如 quality-v1
  paramFingerprint: string;        // 参数指纹
  sourceRefs: SourceRef[];         // 直接来源
  status: ComputationStatus;
  payload: ComputationPayload;
  digest: string;
  createdAt: number;
}

// ---------- 决定 / 锁定 ----------
export type DecisionBasis =
  | 'LOW_AMPLITUDE_NO_GUESS'        // 低振幅区域不得猜相位
  | 'CUT_OFFSET_EXPLICIT'           // 切口两侧整周偏移须显式
  | 'MULTI_TREE_LOCAL_CONSISTENCY'  // 不同展开树可局部一致，须保留路径与循环残差
  | 'LOOP_NONCLOSURE'               // 循环不闭合
  | 'WAVELENGTH_VERSION'            // 波长版本变更
  | 'MANUAL_PREFERENCE';            // 人工偏好

export interface LocalLock {
  id: string;                      // lock_<digest16>
  region: { x0: number; y0: number; x1: number; y1: number };
  candidateId: string;
  basis: DecisionBasis;
  active: boolean;
  createdAt: number;
}

// ---------- 事件（机器可读取） ----------
export type EventType =
  | 'baseline_committed'
  | 'input_imported'
  | 'input_revised'
  | 'computation_completed'
  | 'candidate_proposed'
  | 'candidate_adopted'
  | 'candidate_rejected'
  | 'local_lock_set'
  | 'local_lock_released'
  | 'lock_conflict_detected'
  | 'conflict_resolved'
  | 'undo_applied'
  | 'results_expired'
  | 'case_replayed'
  | 'export_created'
  | 'import_completed';

export interface DomainEvent {
  id: string;      // evt_<seq>_<digest8>
  seq: number;     // 全局顺序，导出/导入后保持
  type: EventType;
  at: number;      // 虚拟时钟
  actor: string;
  payload: Record<string, unknown>; // 含引用 {id, version, digest} 与判定依据
}

// ---------- 反例档案 / 场景 ----------
export type ScenarioKind =
  | 'phase_boundary_crossing'  // 相位跨越边界
  | 'low_amplitude_hole'       // 低振幅孔洞
  | 'multi_connected_region'   // 多连通区
  | 'loop_nonclosure'          // 循环不闭合
  | 'wavelength_version_change'// 波长版本变更
  | 'integer_ambiguity'        // 整周多解
  | 'local_lock_conflict';     // 局部锁定冲突

export const SCENARIO_KINDS: ScenarioKind[] = [
  'phase_boundary_crossing', 'low_amplitude_hole', 'multi_connected_region',
  'loop_nonclosure', 'wavelength_version_change', 'integer_ambiguity',
  'local_lock_conflict',
];

export interface ScenarioRun {
  scenario: ScenarioKind;
  variant: 'minimal' | 'combined';
  inputVersionIds: string[];
  computationIds: string[];
  decisionEventIds: string[];
  diagnostics: string[];
}
