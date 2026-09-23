// 领域数据契约：直接采用光学干涉/相位展开/标定词汇，禁止压成 name/value。
// 输入实体：原相位像素 / 信噪评分 / 无效遮罩 / 波长 / 入射几何 / 标定面 / 切口编辑历史 —— 一经提交不可覆盖。

export const INPUT_KINDS = [
  'wrapped_phase',       // 原相位像素（包裹相位）
  'quality_score',       // 信噪评分（振幅/质量）
  'invalid_mask',        // 无效遮罩
  'wavelength',          // 波长（带单位，版本化）
  'incidence_geometry',  // 入射几何（入射角 + 坐标基准）
  'calibration_plane',   // 标定面（参考相位平面）
  'cut_edit_history',    // 切口编辑历史（支路切口编辑，只追加）
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const KIND_LABEL_ZH: Record<InputKind, string> = {
  wrapped_phase: '原相位像素',
  quality_score: '信噪评分',
  invalid_mask: '无效遮罩',
  wavelength: '波长',
  incidence_geometry: '入射几何',
  calibration_plane: '标定面',
  cut_edit_history: '切口编辑历史',
};

export const DERIVED_KINDS = [
  'quality_map',          // 质量图（规范化在派生层完成）
  'unwrap_candidate',     // 展开候选（一棵树×一个整周解）
  'integer_offset_set',   // 切口两侧的显式整周偏移
  'cycle_residual_set',   // 循环残差集合
  'ambiguity_group',      // 整周多解候选集合
  'height_map',           // 表面高度（高度转换链末端）
] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

// 机器可读取的判断事件（“判断依据写成机器可读取的事件”）
export const EVENT_TYPES = [
  'PHASE_CROSSING_BOUNDARY',      // 相位跨越边界
  'LOW_AMPLITUDE_NO_GUESS',       // 低振幅区域不得猜相位
  'MULTI_COMPONENT_REGION',       // 多连通区
  'CYCLE_NONCLOSURE',             // 循环不闭合
  'WAVELENGTH_VERSION_CHANGE',    // 波长版本变更
  'INTEGER_AMBIGUITY',            // 整周多解
  'LOCAL_LOCK_CONFLICT',          // 局部锁定冲突
  'MULTI_TREE_LOCAL_CONSISTENCY', // 不同展开树的局部一致解（保留路径与循环残差）
  'CUT_OFFSET_EXPLICIT',          // 切口两侧整周偏移显式表示
  'UNIT_UNCONVERTIBLE',           // 无法转换的值留在原位置并附诊断
  'DECISION_RECORDED',            // 人工决定（接受/否定/调整/锁定）
  'DECISION_UNDONE',              // 撤销写入历史
  'DERIVATION_FAILED',            // 计算失败诊断（一等数据）
  'CASEPACK_REPLAY',              // 离线案例包重放
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridField {
  width: number;
  height: number;
  unit: string;            // 所有领域量携带单位，导入保留原始表示
  frame: string;           // 坐标基准，如 'pixel@origin-top-left'
  data: number[];
}

export interface MaskGrid {
  width: number;
  height: number;
  frame: string;
  data: number[];          // 1 = 无效
}

export interface CutSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface WavelengthValue {
  value: number;
  unit: string;            // 'nm' / 'um'，可转换单位在派生层规范化
}

export interface IncidenceGeometry {
  thetaDeg: number;        // 入射角
  unit: 'deg';
  frame: string;           // 入射基准面
}

export interface CalibrationPlane {
  a: number;
  b: number;
  c: number;
  unit: string;            // 相位系数单位，如 'rad/pixel'
  frame: string;
}

export interface InputVersion {
  id: string;
  kind: InputKind;
  versionNo: number;
  parentId: string | null;
  contentHash: string;     // 不可变内容摘要
  content: unknown;        // 原始表示，永不规范化覆盖
  affectedRegion: Region | null; // 局部补丁只影响局部依赖
  submittedSeq: number;
  submittedAt: number;
}

export interface SourceRef {
  id: string;              // 精确引用版本身份，绝不退回“最新版”
  kind: InputKind | DerivedKind;
  versionNo: number;
  contentHash: string;
}

export type DerivedStatus = 'current' | 'stale'; // 过期结果仍可查看，但不能冒充当前结果

export interface DerivedResult {
  id: string;
  kind: DerivedKind;
  algorithmVersion: string;
  paramFingerprint: string;
  sources: SourceRef[];
  contentHash: string;
  content: unknown;
  status: DerivedStatus;
  pixels: number[] | null;   // 局部依赖范围（局部输入变化只使依赖它的结果过期）
  createdSeq: number;
  createdAt: number;
}

export type DecisionAction =
  | 'accept_candidate'
  | 'reject_candidate'
  | 'lock_local'
  | 'unlock_local'
  | 'adjust_param'
  | 'undo';

export interface Decision {
  id: string;
  seq: number;
  action: DecisionAction;
  targetId: string;        // accept/reject/lock 的对象；undo 时为被撤销决定 id
  rationale: string;
  region: Region | null;
  paramPatch: Record<string, unknown> | null;
  effective: boolean;      // 经事件重放后的生效状态（undo 后为 false）
  createdAt: number;
}

export interface EventSnapshot {
  inputVersions: Partial<Record<InputKind, string>>;
  adoptedCandidateId: string | null;
  rejectedCandidateIds: string[];
  locks: { lockDecisionId: string; candidateId: string; region: Region }[];
  currentCandidateIds: string[];
  staleCandidateIds: string[];
  notes: string;
}

export interface EventRecord {
  id: string;
  seq: number;
  type: EventType;
  subjects: string[];
  basis: Record<string, unknown>; // 机器可读取的判断依据
  snapshot: EventSnapshot;
  createdAt: number;
}

export class CorruptReferenceError extends Error {
  constructor(
    public missing: { id: string; referencedBy: string }[],
  ) {
    super('CORRUPT_REFERENCE');
    this.name = 'CorruptReferenceError';
  }
}

export function regionsOverlap(a: Region, b: Region): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

export function regionContains(r: Region, pixel: number, width: number): boolean {
  const x = pixel % width;
  const y = Math.floor(pixel / width);
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}
