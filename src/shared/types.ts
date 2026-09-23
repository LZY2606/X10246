/** 领域词汇：不压成 name/value，直接使用干涉/相位展开/标定术语。 */

export const INPUT_KINDS = [
  'wrapped_phase',        // 原相位像素（包裹相位）
  'snr_score',            // 信噪评分 / 质量图
  'invalid_mask',         // 无效遮罩
  'wavelength',           // 波长
  'incident_geometry',    // 入射几何
  'calibration_surface',  // 标定面
  'cut_edit_history',     // 切口编辑历史
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const DERIVATION_KINDS = [
  'unwrap_candidate_set', // 整周候选集合（含多解）
  'cut_network',          // 切口网络（两侧整周偏移显式）
  'cycle_residuals',      // 循环残差
  'height_map',           // 高度转换链结果
] as const;
export type DerivationKind = (typeof DERIVATION_KINDS)[number];

export const SCENARIOS = [
  'phase_cross_boundary',   // 相位跨越边界
  'low_amplitude_holes',    // 低振幅孔洞
  'multi_connected_region', // 多连通区
  'cycle_non_closure',      // 循环不闭合
  'wavelength_version_change', // 波长版本变更
  'integer_cycle_ambiguity',   // 整周多解
  'local_lock_conflict',       // 局部锁定冲突
] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export interface Quantity {
  value: number;
  unit: string;   // 'rad' | 'nm' | 'deg' | '1' ...
  frame?: string; // 坐标基准，如 'pixel(row,col)' / 'lab'
}

export interface Grid {
  rows: number;
  cols: number;
  /** 行优先，长度 rows*cols；NaN 表示该像素无原始表示 */
  data: number[];
  unit: string;
  frame: string;
}

export interface SourceRef {
  entity: 'input' | 'derivation';
  id: string;
  version: number;
}

export type CandidateStatus = 'proposed' | 'accepted' | 'rejected' | 'locked';
export type DerivationStatus = 'current' | 'stale';

/** 切口边：两侧的整周偏移显式表示 */
export interface CutEdge {
  a: number; // 像素线性索引
  b: number;
  gradRad: number;   // 包裹梯度（rad）
  offsetCycles: number; // 显式整周偏移 k：unwrap[b] = unwrap[a] + grad + 2πk
}

/** 循环残差（机器可读判断依据） */
export interface CycleResidual {
  cycleId: string;
  path: number[];        // 构成循环的像素路径
  residualCycles: number; // 闭合残差（单位：整周）
  status: 'closed' | 'open'; // open = 循环不闭合
}

/** 单个展开候选：一棵树 + 各连通分量的显式整周偏移 */
export interface UnwrapCandidate {
  candidateId: string;
  treeSpec: string;                 // 展开树描述（种子/策略）
  componentOffsets: Record<number, number>; // 分量 -> 相对整周偏移
  unknownPixels: number[];          // 低振幅区域：不得猜相位，保持未知
  unwrapped: number[];              // NaN = 未知
  cutEdges: CutEdge[];
  residuals: CycleResidual[];
  locallyConsistent: boolean;
  status: CandidateStatus;
  rejectReason?: string;
}

export interface HeightChainStep {
  step: string;
  algorithmVersion: string;
  paramsFingerprint: string;
  sources: SourceRef[];
  summary: string;
}

export interface HeightMapPayload {
  heights: number[]; // nm，NaN = 未知（对应低振幅未知像素）
  unit: 'nm';
  frame: string;
  chain: HeightChainStep[];
  diagnostics: string[]; // 无法转换的值留在原位置并附诊断
}
