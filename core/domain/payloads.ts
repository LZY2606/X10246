/** 各类实体的载荷定义：直接采用光学干涉/相位展开/标定的领域词汇。 */
import type { Grid, Qty } from './types.js';

export interface WrappedPhasePayload {
  frame: Grid;                 // radian_wrapped，(-π, π]
  /** 跨越边界（wrap discontinuity）逐边标记，导入时由原始像素判定，供边界情形复核。 */
  wrapEdges: WrapEdge[];
}

export interface WrapEdge {
  edgeId: string;              // e:a:r:c:dir
  from: [number, number];      // [col,row]
  to: [number, number];
  rawDelta: number;            // 未包裹差
  wrapped: boolean;            // |rawDelta| > π
}

export interface AmplitudePayload {
  frame: Grid;                 // 原始振幅，单位按导入保留
  rawUnitNote: string;
}

export interface QualityScorePayload {
  /** 信噪评分 0..1，逐像素；输入即不可覆盖。 */
  frame: Grid;                 // adimensional
  derivedFromAmplitude: boolean;
  threshold: number;           // 低于阈值=低振幅孔洞，不得猜相位
}

export interface InvalidMaskPayload {
  width: number;
  height: number;
  /** 无效像素集合（被遮罩）。 */
  invalidPixels: [number, number][];
  /** 多连通：有效像素的连通分量标签。 */
  componentLabels?: Record<string, number>;
  componentCount?: number;
}

export interface WavelengthPayload {
  wavelength: Qty;             // 原始单位保留（nm/µm…）
  wavelengthNanometers: number | null; // 派生层规范化；无法转换为 null
  revisionReason?: string;
}

export interface IlluminationGeometryPayload {
  incidenceAngle: Qty;         // degree
  /** 灵敏度因子 cos? convention: OPD = 2*h*cos(theta)/... 这里采用反射式斜入射。 */
  convention: 'reflection_oblique' | 'normal_incidence';
  propagationDirection: [number, number, number]; // 入射方向单位向量约定
  beamCount: 1 | 2;
}

export interface CalibrationPlanePayload {
  /** 标定面（参考平面）：z = a*x + b*y + c，坐标基准物理化。 */
  coefficients: { a: number; b: number; c: number };
  coefficientUnit: 'micrometer_per_pixel' | 'millimeter_per_pixel' | 'meter_per_meter';
  basis: { pitchX: Qty; pitchY: Qty };
  residualRmsMicrometer: number | null;
  calibrationFrames: { frameId: string; note: string }[];
}

export interface CutEditRecordPayload {
  edits: CutEdit[];
}

export interface CutEdit {
  editId: string;
  at: number;
  editor: 'human' | 'auto_balanced';
  kind: 'add_branch_cut' | 'remove_branch_cut' | 'force_border_dipole';
  from: [number, number];
  to: [number, number];
  reason: string;
  supersedesEdit?: string;
}

export type ResidueCharge = 1 | -1 | 0;

export interface ResidueMapPayload {
  width: number;
  height: number;
  /** 每个 2x2 小环（plaquette）的环绕包裹差，归一到 (-π,π]。 */
  plaquettes: Plaquette[];
}

export interface Plaquette {
  pid: string;                 // p:r:c
  anchor: [number, number];    // 左上角 [col,row]
  wrappedLoop: number;
  charge: ResidueCharge;       // round(wrappedLoop/2π)
  residualCycles: number;      // wrappedLoop/2π
}

export interface BranchCut {
  cutId: string;
  from: [number, number];      // 像素或残差点坐标
  to: [number, number];
  kind: 'residue_pair' | 'border_dipole' | 'human';
  editId?: string;             // 人工切口对应编辑历史
  weight: number;
}

export interface BranchCutNetworkPayload {
  cuts: BranchCut[];
  unbalancedCharges: [number, number, ResidueCharge][]; // 仍未配平的残差→循环不闭合
  borderBalancedCount: number;
}

export interface QualityMapPayload {
  frame: Grid;                 // adimensional 0..1
  lowAmplitudeHoles: [number, number][];
  unknownPixels: [number, number][]; // 低振幅/无效：状态 unknown，禁止猜相位
}

export interface TreeEdge {
  edgeId: string;
  from: [number, number];
  to: [number, number];
  rawDelta: number;
  wrappedDelta: number;
  crossesCut: boolean;
  cutId?: string;
  /** 该边两侧的整周偏移以显式整数表示（不许把 2π 差藏在数值里）。 */
  integerJump: number | null;  // null = 跨切口且未裁定/低振幅，不得猜
  ambiguous: boolean;
  ambiguityReasons: string[];
}

export interface UnwrapTreePayload {
  treeId: string;
  strategy: 'quality_guided_prim' | 'shortest_path_dijkstra';
  /** 展开森林：多连通区每个分量一棵独立树。 */
  roots: [number, number][];
  edges: TreeEdge[];
  /** 树上每个节点相对根的整周序数 k；低振幅/无效为 null（未知）。 */
  orderField: (number | null)[];
  width: number;
  height: number;
}

export interface IntegerOffsetFieldPayload {
  width: number;
  height: number;
  /** 每像素整周候选集合；空集=未知（低振幅/无效）；多元素=整周多解。 */
  candidates: IntegerCandidate[][];
}

export interface IntegerCandidate {
  k: number;
  treeId: string;
  support: number;             // 支撑边数
  rejectedReason?: string;
  accepted?: boolean;
}

export interface UnwrappedPhaseFieldPayload {
  frame: Grid;                 // radian（连续）；未知像素 null
  unknownPixels: [number, number][];
  ambiguousPixels: [number, number][];
}

export interface CycleResidual {
  cycleId: string;
  nodes: [number, number][];
  trees: string[];             // 参与的展开树
  residualCycles: number;      // 闭合环上的整周残差；0=闭合，非0=循环不闭合
  closed: boolean;
  crossesCuts: string[];
  blockedByUnknown: boolean;
  note: string;
}

export interface CycleResidualLedgerPayload {
  cycles: CycleResidual[];
}

export type HeightLinkStatus = 'ok' | 'unknown' | 'unconvertible' | 'ambiguous';

export interface HeightLink {
  linkId: string;
  fromPath: string;
  toPath: string;
  formula: string;
  value: number | null;
  unit: string;
  status: HeightLinkStatus;
  diagnostic?: string;
  sourceRefs: string[];        // versionId
}

export interface HeightChainPayload {
  /** 每个像素一条转换链：wrapped → unwrapped(rad) → OPD(nm) → height(µm) → 标定残差。 */
  pixels: {
    at: [number, number];
    links: HeightLink[];
    heightMicrometer: number | null;
    calibratedResidualMicrometer: number | null;
    status: HeightLinkStatus;
  }[];
  wavelengthVersionId: string;
  geometryVersionId: string;
  calibrationVersionId: string | null;
}

export interface LockDecisionPayload {
  target:
    | { kind: 'pixel_candidate'; at: [number, number]; chosenK: number }
    | { kind: 'cut_offset'; cutId: string; chosenIntegerJump: number }
    | { kind: 'tree_local'; treeId: string; root: [number, number] }
    | { kind: 'height_pixel'; at: [number, number] };
  decision: 'accept' | 'reject' | 'parameter_adjust';
  rationale: string;
  /** 锁定时引用的全部依赖版本；回到此事件时恢复这些版本而非最新版。 */
  pinnedVersions: { entityId: string; version: number }[];
  conflictsWith?: string[];    // 与之冲突的 decisionId
  undoneBy?: string;
  paramsAfterAdjust?: Record<string, unknown>;
}

export interface ArchiveVerdictPayload {
  scenario: CounterexampleScenario;
  baselineDigest: string;
  singleSourceChanged: { entityId: string; fromVersion: number; toVersion: number };
  expectedImpactScope: string[];   // 应当过期/变化的实体 versionId
  unexpectedImpactScope: string[]; // 不应受影响却受影响（空=隔离正确）
  affectedObjects: string[];
  adopted: { versionId: string; why: string }[];
  rejected: { versionId: string; why: string }[];
  ruleId: string;
  ruleStatement: string;
  passed: boolean;
  diagnostics: string[];
}

export type CounterexampleScenario =
  | 'phase_wrap_boundary'
  | 'low_amplitude_hole'
  | 'multiply_connected_region'
  | 'cycle_nonclosure'
  | 'wavelength_version_change'
  | 'integer_multiplicity'
  | 'local_lock_conflict';
