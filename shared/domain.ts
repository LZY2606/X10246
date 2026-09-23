// 领域数据契约：光学干涉 / 相位展开 / 标定
// 所有实体使用领域词汇，不压成 name/value。

/** 输入实体种类：基线七项，均不可覆盖，只能以新版本+父版本关系修订 */
export type InputKind =
  | 'wrapped_phase'       // 原相位像素（包裹相位，rad，(-π, π]）
  | 'snr_score'           // 信噪评分（含振幅，用于质量图与低振幅判定）
  | 'invalid_mask'        // 无效遮罩
  | 'wavelength'          // 波长
  | 'incident_geometry'   // 入射几何
  | 'calibration_surface' // 标定面
  | 'cut_edit_history';   // 切口编辑历史

export const INPUT_KINDS: InputKind[] = [
  'wrapped_phase', 'snr_score', 'invalid_mask', 'wavelength',
  'incident_geometry', 'calibration_surface', 'cut_edit_history'
];

export const INPUT_KIND_LABEL: Record<InputKind, string> = {
  wrapped_phase: '原相位像素',
  snr_score: '信噪评分',
  invalid_mask: '无效遮罩',
  wavelength: '波长',
  incident_geometry: '入射几何',
  calibration_surface: '标定面',
  cut_edit_history: '切口编辑历史'
};

/** 派生结果种类 */
export type ResultKind =
  | 'quality_map'     // 质量图（信噪评分 + 无效遮罩）
  | 'cut_network'     // 支路切口网络（原相位像素 + 无效遮罩 + 切口编辑历史）
  | 'unwrap_solution' // 相位展开解（含整周候选、路径、循环残差、未知区）
  | 'height_map';     // 高度转换链（展开解 + 波长 + 入射几何 + 标定面）

export const RESULT_KIND_LABEL: Record<ResultKind, string> = {
  quality_map: '质量图',
  cut_network: '切口网络',
  unwrap_solution: '相位展开解',
  height_map: '高度转换链'
};

/** 反例档案的七种情形 */
export type ScenarioName =
  | 'phase_crosses_boundary'    // 相位跨越边界
  | 'low_amplitude_holes'       // 低振幅孔洞
  | 'multiply_connected'        // 多连通区
  | 'cycle_nonclosure'          // 循环不闭合
  | 'wavelength_version_change' // 波长版本变更
  | 'integer_cycle_ambiguity'   // 整周多解
  | 'local_lock_conflict';      // 局部锁定冲突

export const SCENARIOS: ScenarioName[] = [
  'phase_crosses_boundary', 'low_amplitude_holes', 'multiply_connected',
  'cycle_nonclosure', 'wavelength_version_change', 'integer_cycle_ambiguity',
  'local_lock_conflict'
];

export const SCENARIO_LABEL: Record<ScenarioName, string> = {
  phase_crosses_boundary: '相位跨越边界',
  low_amplitude_holes: '低振幅孔洞',
  multiply_connected: '多连通区',
  cycle_nonclosure: '循环不闭合',
  wavelength_version_change: '波长版本变更',
  integer_cycle_ambiguity: '整周多解',
  local_lock_conflict: '局部锁定冲突'
};

/** 判断规则（机器可读事件中的 ruleId） */
export const RULES = {
  LOW_AMPLITUDE_NO_GUESS: 'low_amplitude_no_guess',       // 低振幅区域不得猜相位
  CUT_OFFSET_EXPLICIT: 'cut_offset_explicit',             // 切口两侧整周偏移显式表示
  MULTI_TREE_LOCAL_CONSISTENCY: 'multi_tree_local_consistency' // 不同展开树局部一致解，保留路径与循环残差
} as const;

// ---------- 网格与内容 ----------

export interface GridShape { width: number; height: number }

export interface WrappedPhaseContent extends GridShape {
  values: number[]; // rad, (-π, π]，行主序，坐标基准 datum 记录在版本上
}
export interface SnrScoreContent extends GridShape {
  amplitude: number[]; // 振幅（count）
  snr: number[];       // 信噪评分（dB）
}
export interface InvalidMaskContent extends GridShape {
  invalid: (0 | 1)[];
}
export interface WavelengthContent { value: number } // 单位记录在版本 unit 上（nm/um/mm）
export interface IncidentGeometryContent {
  mode: 'reflection' | 'transmission';
  thetaDeg: number; // 入射角，基准 datum = lab-frame
}
export interface CalibrationSurfaceContent extends GridShape {
  values: number[]; // 高度（单位记录在版本 unit 上）
}
export interface CutEditHistoryContent {
  edits: { edge: [number, number, number, number]; action: 'add' | 'remove'; note?: string }[];
}

export type InputContent =
  | WrappedPhaseContent | SnrScoreContent | InvalidMaskContent
  | WavelengthContent | IncidentGeometryContent
  | CalibrationSurfaceContent | CutEditHistoryContent;

// ---------- 派生层载荷 ----------

export interface QualityMapPayload extends GridShape {
  quality: number[];             // 0..1
  flags: string[][];             // 每像素: 'invalid' | 'low_amplitude' | 'low_snr'
  lowAmplitudeThreshold: number;
}

export interface CutEdge {
  a: [number, number];
  b: [number, number];
  kind: 'branch' | 'manual' | 'hole_boundary';
}
export interface CutNetworkPayload extends GridShape {
  residues: ({ x: number; y: number; value: -1 | 1 })[];
  edges: CutEdge[];
}

export interface CycleResidual {
  cycleId: string;
  path: [number, number][]; // 循环路径（像素坐标）
  residualTurns: number;    // 以 2π 为单位的残差（整数）；非零即循环不闭合
  acrossCut: boolean;
}
export interface CutCrossing {
  edge: [[number, number], [number, number]];
  kOffset: number; // 切口两侧显式整周偏移
}
export interface UnwrapCandidate {
  candidateId: string;
  componentOffsets: Record<string, number>; // 连通分量 -> 整周偏移 k
  unwrapped: (number | null)[];             // rad，未知为 null
  consistent: boolean;                      // 所有非切口循环残差为零
  rejectedReasons: string[];                // 被拒绝/不可唯一决定的原因
}
export interface UnwrapSolutionPayload extends GridShape {
  unknowns: [number, number][];             // 低振幅/无效区：不得猜相位
  components: { componentId: string; size: number; seed: [number, number] }[];
  treePaths: { tree: 'quality' | 'rowmajor'; parent: (number | null)[] }[]; // 两种展开树路径
  locallyConsistent: boolean[];             // 每像素：两树是否给出局部一致解
  cutCrossings: CutCrossing[];
  cycles: CycleResidual[];
  candidates: UnwrapCandidate[];            // 全部合法候选（无法唯一决定时全部保留）
  judgments: { ruleId: string; detail: string }[];
}

export interface HeightChainStep {
  step: string;
  sourceVersionId: string | null;
  note: string;
}
export interface HeightMapPayload extends GridShape {
  heights: (number | null)[]; // nm；无法转换留在原位置（null）并附诊断
  unit: 'nm';
  datum: string;              // 高度基准：标定面
  chain: HeightChainStep[];
  diagnostics: string[];
}

// ---------- 事件 ----------

export type EventType =
  | 'baseline_frozen' | 'input_imported' | 'input_revised'
  | 'scenario_triggered' | 'candidates_generated'
  | 'candidate_adopted' | 'candidate_rejected'
  | 'local_lock_set' | 'local_lock_conflict'
  | 'param_adjusted' | 'undo' | 'exported' | 'imported' | 'judgment';

export interface DomainEvent {
  seq: number;
  id: string;
  type: EventType;
  at: string; // ISO，虚拟时钟注入
  payload: Record<string, unknown>;
}

export const EXPORT_FORMAT_VERSION = 'fringe-book-export@1';
