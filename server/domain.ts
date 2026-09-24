import { createHash } from 'node:crypto';

/**
 * 领域词汇表：数据契约直接使用光学干涉/相位展开/标定领域词汇，
 * 而不是把一切压成 name/value。
 */

export const INPUT_KINDS = [
  'wrapped_phase',        // 原相位像素（包裹相位）
  'amplitude',            // 振幅 / 信噪评分来源
  'invalid_mask',         // 无效遮罩
  'wavelength',           // 波长
  'incidence_geometry',   // 入射几何
  'calibration_plane',    // 标定面
  'cut_edit_history',     // 切口编辑历史
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const DERIVED_KINDS = [
  'quality_map',          // 质量图（信噪评分）
  'cycle_residuals',      // 循环残差
  'cut_network',          // 切口网络（支路切口）
  'regions',              // 连通区划分
  'unwrap_candidates',    // 整周候选
  'unwrapped_phase',      // 展开相位
  'height_map',           // 表面高度（高度转换链末端）
] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

export const SCENARIO_KINDS = [
  'phase_cross_boundary',      // 相位跨越边界
  'low_amplitude_hole',        // 低振幅孔洞
  'multi_connected_region',    // 多连通区
  'cycle_nonclosure',          // 循环不闭合
  'wavelength_version_change', // 波长版本变更
  'integer_cycle_ambiguity',   // 整周多解
  'local_lock_conflict',       // 局部锁定冲突
] as const;
export type ScenarioKind = (typeof SCENARIO_KINDS)[number];

export const SCENARIO_LABELS: Record<ScenarioKind, string> = {
  phase_cross_boundary: '相位跨越边界',
  low_amplitude_hole: '低振幅孔洞',
  multi_connected_region: '多连通区',
  cycle_nonclosure: '循环不闭合',
  wavelength_version_change: '波长版本变更',
  integer_cycle_ambiguity: '整周多解',
  local_lock_conflict: '局部锁定冲突',
};

/** 判断规则（机器可读取事件的 rationale 编码） */
export const JUDGMENT_RULES = {
  no_guess_low_amplitude: 'low_amplitude_region_must_not_guess_phase', // 低振幅区域不得猜相位
  explicit_cycle_offset: 'cut_side_cycle_offset_must_be_explicit',     // 切口两侧整周偏移显式表示
  keep_path_and_residual: 'different_trees_keep_path_and_cycle_residual', // 不同展开树保留路径与循环残差
} as const;

export interface Grid {
  width: number;
  height: number;
  data: number[]; // 行主序
}

export interface SourceRef {
  id: string;       // 输入版本 id 或派生结果 id 或事件 id
  version?: number; // 输入版本号
  digest: string;   // 内容摘要
  kind: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  at?: { x: number; y: number } | { region: number } | null;
}

export type DerivedStatus = 'current' | 'stale' | 'failed' | 'unknown';

/** 整周候选：一个连通区相对锚点的整周偏移 k，附路径与循环残差 */
export interface CycleCandidate {
  candidateId: string;
  region: number;
  kOffset: number;            // 整周数 k（单位：2π 周期）
  path: Array<[number, number]>; // 展开树路径（像素坐标）
  cycleResidual: number;      // 沿路径闭合循环的残差（rad）
  status: 'pending' | 'adopted' | 'rejected' | 'locked';
  rejectionReason: string | null;
}

export type DecisionType =
  | 'candidate.adopt'
  | 'candidate.reject'
  | 'candidate.lock'
  | 'candidate.unlock'
  | 'param.adjust'
  | 'decision.undo'
  | 'conflict.record'
  | 'note';

export interface DomainEvent {
  seq: number;
  id: string;
  projectId: string;
  branch: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** 稳定身份：可导出的内容寻址摘要 */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** 固定 seed 的确定性随机数（演示与测试共用，绝不访问真随机源） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const TWO_PI = Math.PI * 2;

/** 包裹到 [-π, π) */
export function wrapPhase(v: number): number {
  let w = v % TWO_PI;
  if (w >= Math.PI) w -= TWO_PI;
  if (w < -Math.PI) w += TWO_PI;
  return w;
}
