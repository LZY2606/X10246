/**
 * 领域词汇与数据契约：光学干涉 / 二维相位展开 / 标定。
 * 所有实体携带稳定身份（entityId + version），所有领域量携带单位或坐标基准。
 */

/** 输入实体种类：基线一经提交不可覆盖，修订以新版本+父版本表达 */
export const INPUT_KINDS = [
  'wrapped_phase',       // 原相位像素（包裹相位，rad，[-π,π)）
  'amplitude',           // 振幅帧
  'snr_map',             // 信噪评分
  'invalid_mask',        // 无效遮罩
  'wavelength',          // 波长（nm）
  'incidence_geometry',  // 入射几何
  'calibration_plane',   // 标定面
  'cut_edit_history',    // 切口编辑历史
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

/** 派生实体种类：都带算法版本、参数指纹与直接来源 */
export const DERIVED_KINDS = [
  'quality_map',      // 质量图
  'residue_map',      // 留数场 + 循环残差
  'component_map',    // 多连通区标号
  'cut_network',      // 切口网络（切口两侧整周偏移显式表示）
  'unwrap_solution',  // 展开解（展开树、路径、整周场、未知像素）
  'height_map',       // 高度转换链（相位→光程→高度→去标定面）
] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];
export type EntityKind = InputKind | DerivedKind;

export const KIND_LABEL: Record<EntityKind, string> = {
  wrapped_phase: '原相位像素',
  amplitude: '振幅帧',
  snr_map: '信噪评分',
  invalid_mask: '无效遮罩',
  wavelength: '波长',
  incidence_geometry: '入射几何',
  calibration_plane: '标定面',
  cut_edit_history: '切口编辑历史',
  quality_map: '质量图',
  residue_map: '循环残差',
  component_map: '多连通区',
  cut_network: '切口网络',
  unwrap_solution: '展开相位',
  height_map: '高度转换链',
};

/** 反例档案的七类检验情形 */
export const SCENARIOS = [
  'phase_crosses_boundary', // 相位跨越边界
  'low_amplitude_holes',    // 低振幅孔洞
  'multi_component',        // 多连通区
  'cycle_inconsistency',    // 循环不闭合
  'wavelength_revision',    // 波长版本变更
  'multi_solution',         // 整周多解
  'lock_conflict',          // 局部锁定冲突
] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export const SCENARIO_LABEL: Record<ScenarioId, string> = {
  phase_crosses_boundary: '相位跨越边界',
  low_amplitude_holes: '低振幅孔洞',
  multi_component: '多连通区',
  cycle_inconsistency: '循环不闭合',
  wavelength_revision: '波长版本变更',
  multi_solution: '整周多解',
  lock_conflict: '局部锁定冲突',
};

/** 算法版本：任何派生值都标注 */
export const ALGO_VERSIONS = {
  quality: 'quality-map@1',
  residues: 'residue-scan@1',
  components: 'component-label@1',
  cuts: 'branch-cut@1',
  unwrapBfs: 'unwrap-bfs-tree@1',
  unwrapQuality: 'unwrap-quality-tree@1',
  height: 'height-chain@1',
} as const;

/** 领域参数（默认值，进入参数指纹） */
export interface DomainParams {
  lowAmplitudeThreshold: number; // 低振幅阈值：低于此值不得猜相位
  minSn: number;                 // 信噪评分下限
  maxCandidateOffset: number;    // 整周多解搜索范围（周）
  fringeCount: number;           // 合成条纹数
}
export const DEFAULT_PARAMS: DomainParams = {
  lowAmplitudeThreshold: 0.2,
  minSn: 0.1,
  maxCandidateOffset: 1,
  fringeCount: 6,
};

/** 网格数据：所有值带单位与坐标基准 */
export interface Grid {
  width: number;
  height: number;
  unit: string;        // 'rad' | '1' | 'nm' | 'bool'
  coordFrame: string;  // 坐标基准，如 'detector-pixel'
  values: number[];    // 行主序；NaN 表示未知/缺失（序列化为 null）
}

export interface GridPayload {
  grid: Grid;
  note?: string;
}

export interface WavelengthPayload {
  valueNm: number;
  unit: 'nm';
  source: string; // 原始表示（如 "632.8 nm HeNe"）
}

export interface IncidenceGeometryPayload {
  type: 'michelson-normal' | 'fizeau' | 'oblique';
  incidenceAngleDeg: number;
  doublePass: boolean;
  sensitivityNmPerRad: number; // nm/rad，由几何决定
  unit: 'nm/rad';
}

export interface CalibrationPlanePayload {
  coefficients: [number, number, number]; // ax+by+c，单位 nm，坐标基准 detector-pixel
  unit: 'nm';
  coordFrame: string;
}

export interface CutEdit {
  editId: string;
  at: string;
  actor: string;
  action: 'add' | 'remove';
  /** 折线像素路径 [[x,y],...]，显式整周偏移（周） */
  polyline: Array<[number, number]>;
  offsetTurns: 1 | -1;
  reason: string;
}
export interface CutEditHistoryPayload {
  edits: CutEdit[];
}

export type InputPayload =
  | GridPayload
  | WavelengthPayload
  | IncidenceGeometryPayload
  | CalibrationPlanePayload
  | CutEditHistoryPayload;

/** 派生内容 */
export interface QualityPayload {
  grid: Grid; // [0,1]，低振幅/无效处为 0
  lowAmplitudePixels: number[]; // 低振幅像素线性索引（不得猜相位）
}
export interface CycleResidual {
  corners: Array<[number, number]>;
  residualRad: number;
  charged: boolean;
  unverifiable?: boolean; // 含未知像素，无法闭合验证
  blockedByCut?: boolean; // 环边被切口穿过
  blockedByCut?: boolean; // 环边被切口穿过
}
export interface ResiduePayload {
  grid: Grid; // 每个 2x2 环左上角的留数（rad），无环处为 0
  cycles: CycleResidual[];
  chargedCount: number;
}
export interface ComponentPayload {
  grid: Grid; // 标号：0=无效，1..n=连通区
  componentCount: number;
  componentSizes: number[];
}
export interface CutSegment {
  id: string;
  polyline: Array<[number, number]>;
  offsetTurns: 1 | -1; // 跨越切口时的整周偏移（显式）
  source: 'auto' | 'manual';
}
export interface CutNetworkPayload {
  cuts: CutSegment[];
  width: number;
  height: number;
}
export interface UnwrapPayload {
  grid: Grid;              // 展开相位（rad），未知像素为 NaN
  kGrid: Grid;             // 整周场 k（周），未知像素为 NaN
  strategy: string;        // 展开树策略
  componentRoots: Record<number, [number, number]>; // 每连通区根像素
  globalOffsets: Record<number, number>;            // 每连通区全局整周偏移（候选）
  treeParents: number[];   // 展开树父指针（线性索引，-1=根/无效）
  unknownPixels: number[]; // 低振幅/不可达像素：不猜相位
  cycleResidualsAfter: CycleResidual[]; // 展开后循环残差
  cutOffsets: CutSegment[];             // 解依赖的切口及其显式偏移
  familyId: string;        // 候选族
  candidateIndex: number;
}
export interface HeightPayload {
  grid: Grid; // 高度（nm），未知像素 NaN
  opdGrid: Grid;     // 光程差（nm）
  rawHeightGrid: Grid; // 去标定面前高度（nm）
  wavelengthNm: number;
  wavelengthRef: string; // 波长实体@版本
  sensitivityNmPerRad: number;
  calibrationRemoved: boolean;
  chain: string[]; // 转换链说明：psi -> k -> Phi -> OPD -> h -> h-cal
}
export type DerivedPayload =
  | QualityPayload | ResiduePayload | ComponentPayload
  | CutNetworkPayload | UnwrapPayload | HeightPayload;

/** 实体记录（存储层行） */
export interface EntityRecord {
  entityId: string;
  kind: EntityKind;
  version: number;
  parentEntityId: string | null;
  status: 'current' | 'stale' | 'locked' | 'rejected' | 'superseded' | 'candidate';
  algo: string | null;
  paramFingerprint: string | null;
  contentHash: string;
  content: unknown;
  summary: string;
  createdAt: string;
  createdByEvent: string | null;
  scenario: string | null;
  fragmentId?: string | null;
}

/** 依赖边：派生实体 -> 直接来源（精确到版本） */
export interface EdgeRecord {
  fromEntityId: string;
  toEntityId: string;
  toVersion: number;
}

/** 机器可读的判定事件 */
export type EventType =
  | 'baseline_committed'        // 基线提交（不可覆盖）
  | 'input_revised'             // 输入修订（新版本）
  | 'params_revised'            // 领域参数修订（新版本参数指纹）
  | 'computation_completed'     // 派生计算完成
  | 'candidate_generated'       // 整周多解候选生成
  | 'candidate_adjudicated'     // 候选裁定（采纳/拒绝，带原因）
  | 'solution_locked'           // 局部解锁定
  | 'lock_conflict'             // 锁定冲突
  | 'lock_conflict_resolved'    // 冲突解决
  | 'decision_reverted'         // 撤销人工决定
  | 'diagnostic_raised'         // 诊断（不可转换值等）
  | 'archive_exported'
  | 'archive_imported';

export interface EventRecord {
  eventId: string;
  seq: number;
  at: string;
  type: EventType;
  actor: string;
  rationale: string; // 判断依据（机器可读 payload 之外的人读摘要）
  payload: Record<string, unknown>;
}

export interface LockRecord {
  lockId: string;
  componentId: number;
  solutionEntityId: string;
  status: 'active' | 'conflicted' | 'resolved-adopted' | 'resolved-rejected' | 'reverted';
  createdAt: string;
  createdByEvent: string;
  note: string;
}

/** 案例包 */
export interface CasePackManifest {
  format: 'interferometry-casepack@1';
  title: string;
  seed: number;
  scenarios: Array<{
    scenarioId: ScenarioId;
    label: string;
    minimalCaseKey: string;
    combinedCaseKey: string;
  }>;
}
