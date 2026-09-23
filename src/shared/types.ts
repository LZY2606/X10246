/**
 * 数据契约：直接使用光学干涉 / 相位展开 / 标定领域词汇，
 * 不把领域量压成 name/value。
 */

// ---------- 输入实体（不可覆盖，修订以新版本+父版本表达） ----------
export type InputKind =
  | 'wrapped_phase'       // 原相位像素（包裹相位，rad，(-π, π]）
  | 'snr_score'           // 信噪评分（质量图源数据）
  | 'invalid_mask'        // 无效遮罩
  | 'wavelength'          // 波长（含原始表示与单位）
  | 'incidence_geometry'  // 入射几何（入射角/方位角，坐标基准）
  | 'calibration_plane'   // 标定面
  | 'cut_edit_history';   // 切口编辑历史

export const INPUT_KINDS: InputKind[] = [
  'wrapped_phase', 'snr_score', 'invalid_mask',
  'wavelength', 'incidence_geometry', 'calibration_plane', 'cut_edit_history',
];

export interface GridData {
  width: number;
  height: number;
  /** 行优先展开，长度 = width * height */
  values: number[];
  unit: string;          // 'rad' | 'dB' | 'bool(0/1)' ...
  coordBasis: string;    // 坐标基准，如 'pixel(row-major,origin=top-left)'
  raw?: string;          // 导入时的原始表示，原样保留
}

export interface WavelengthData {
  raw: string;           // 原始表示，如 "632.8 nm"
  value: number;
  unit: 'nm' | 'um' | 'pm';
}

export interface IncidenceGeometryData {
  raw: string;
  thetaDeg: number;      // 入射角（相对法线）
  phiDeg: number;        // 方位角
  basis: string;         // 坐标基准
}

export interface CalibrationPlaneData {
  raw: string;
  a: number; b: number; c: number; // z = a*x + b*y + c
  unit: 'nm';
  basis: string;
}

export interface CutEdge {
  edgeId: string;
  /** 相邻两像素的行优先索引 */
  a: number;
  b: number;
  /** 切口两侧的显式整周偏移：k[b] = k[a] + offset */
  offset: number;
}

export interface CutEditHistoryData {
  edits: Array<
    | { op: 'add_cut'; edge: CutEdge }
    | { op: 'remove_cut'; edgeId: string }
    | { op: 'set_offset'; edgeId: string; offset: number }
  >;
}

export type InputContent =
  | GridData
  | WavelengthData
  | IncidenceGeometryData
  | CalibrationPlaneData
  | CutEditHistoryData;

// ---------- 决定实体（人工裁定，作为一等事件） ----------
export type DecisionType =
  | 'accept_candidate'   // 采纳某展开候选
  | 'reject_candidate'   // 否定候选（须给原因）
  | 'adjust_params'      // 参数调整（触发重算）
  | 'lock_region'        // 锁定局部解
  | 'unlock_region'      // 解除锁定
  | 'revert_decision';   // 撤销（写入补偿事件，不删历史）

// ---------- 复核实体（派生结果，带算法版本/参数指纹/直接来源） ----------
export type DerivedKind =
  | 'quality_map'      // 质量图（snr + mask 分类）
  | 'component_map'    // 多连通区划分
  | 'cut_network'      // 切口网络（当前切口边与显式偏移）
  | 'unwrap_candidate' // 一次展开树产生的整周场候选
  | 'loop_residuals'   // 循环残差
  | 'height_map';      // 高度转换链结果

export type DerivedStatus =
  | 'proposed'    // 候选，未裁定
  | 'accepted'    // 被采纳
  | 'rejected'    // 被否定（保留，附原因）
  | 'stale'       // 依赖过期：仍可查看，不能冒充当前结果
  | 'conflicted'; // 与局部锁定冲突（保留双方）

export interface SourceRef {
  inputId: string;
  version: number;   // 精确版本，查询缺引用必须报损坏，禁止退回最新版
  digest: string;    // 内容摘要
}

export interface DerivedSourceRef {
  derivedId: string;
  digest: string;
}

// ---------- 诊断（七种验收情形 + 不可转换值） ----------
export type DiagnosticCode =
  | 'PHASE_CROSSING_BOUNDARY'   // 相位跨越边界
  | 'LOW_AMPLITUDE_HOLE'        // 低振幅孔洞：不得猜相位
  | 'MULTI_COMPONENT'           // 多连通区
  | 'LOOP_NONCLOSURE'           // 循环不闭合（残差非零）
  | 'WAVELENGTH_VERSION_CHANGE' // 波长版本变更
  | 'INTEGER_MULTI_SOLUTION'    // 整周多解
  | 'LOCK_CONFLICT'             // 局部锁定冲突
  | 'UNIT_UNCONVERTIBLE';       // 无法转换：留在原位置并附诊断

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  pixels?: number[];
  region?: number[];
  refs?: string[]; // 相关实体 id
}

// ---------- 展开候选载荷 ----------
export interface UnwrapPathStep {
  from: number;
  to: number;
  deltaK: number;
  viaCutEdgeId?: string; // 跨越切口时显式记录
}

export interface LoopResidual {
  plaquette: [number, number]; // 左上角 (row, col)
  path: number[];              // 环绕路径像素索引
  residue: number;             // 非零即循环不闭合
  pathSumRad: number;
}

export interface UnwrapCandidatePayload {
  seed: number;
  strategy: 'quality-guided' | 'raster';
  width: number;
  height: number;
  /** 整周数 k；null = 未知（低振幅孔洞/遮罩，绝不猜相位） */
  kField: Array<number | null>;
  componentOf: Array<number | null>;
  componentCount: number;
  cutOffsets: Array<{ edgeId: string; a: number; b: number; offset: number }>;
  path: UnwrapPathStep[];
  loopResiduals: LoopResidual[];
  unknowns: Array<{ pixel: number; reason: DiagnosticCode }>;
  diagnostics: Diagnostic[];
}

export interface HeightMapPayload {
  width: number;
  height: number;
  unit: 'nm';
  basis: string;
  /** null = 无法转换（未知整周/单位不可转换），留在原位置 */
  heights: Array<number | null>;
  chain: Array<{ step: string; detail: string; params: Record<string, unknown> }>;
  diagnostics: Diagnostic[];
}

export interface QualityMapPayload {
  width: number;
  height: number;
  /** 每像素质量等级：'valid' | 'low-amplitude' | 'masked' */
  classes: Array<'valid' | 'low-amplitude' | 'masked'>;
  snrThreshold: number;
  diagnostics: Diagnostic[];
}

export interface ComponentMapPayload {
  width: number;
  height: number;
  componentOf: Array<number | null>;
  componentCount: number;
  diagnostics: Diagnostic[];
}

export interface CutNetworkPayload {
  edges: CutEdge[];
  diagnostics: Diagnostic[];
}

export interface LoopResidualsPayload {
  residuals: LoopResidual[];
  diagnostics: Diagnostic[];
}
