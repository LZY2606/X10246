// 干涉条纹簿 —— 领域数据契约
// 所有领域量携带单位或坐标基准；原始层保留原始表示，派生层才做规范化。

export type GridUom = 'rad_wrapped' | 'gray_amplitude' | 'snr_db' | 'unitless_quality' | 'unitless'
  | 'rad_unwrapped' | 'cycle_count' | 'cycle_residual_rad' | 'metres_height' | 'metres_wavelength'
  | 'dimensionless_coeff' | 'integer';

export type GeometryKind = 'normal_incidence' | 'off_axis_illumination';

export interface Unit {
  uom: GridUom;
  scale?: number;          // 原始表示到 SI/规范量的倍率；原始值原样保留
  offset?: number;
}

export interface CoordinateBasis {
  origin: [number, number];           // (row,col) 像素原点偏移
  pixelPitch: [number, number];       // 行/列方向像素尺寸（米）
  pitchUom: 'metres';
  crs: string;                        // 坐标基准名称
  sensorRows: number;
  sensorCols: number;
}

export interface Quantity {
  value: number | null;               // null = 未知/无法转换，绝不猜测
  uom: string;
  basis?: string;
  raw?: { repr: string | number; uom: string };  // 原始表示
  diagnostics?: Diagnostic[];
}

export interface Diagnostic {
  code:
    | 'UNCONVERTIBLE_VALUE'
    | 'LOW_AMPLITUDE_HOLD'
    | 'INVALID_MASKED'
    | 'CUT_CROSSING'
    | 'RESIDUE_PRESENT'
    | 'CYCLE_NOT_CLOSED'
    | 'INTEGER_AMBIGUITY'
    | 'MULTI_COMPONENT_OFFSET'
    | 'LOCK_CONFLICT'
    | 'STALE_DERIVED'
    | 'WAVELENGTH_VERSION_DRIFT'
    | 'REJECTED_CANDIDATE'
    | 'FORMAT_ERROR'
    | 'MISSING_REFERENCE';
  message: string;
  severity: 'info' | 'warning' | 'error';
  at?: [number, number];
  refs?: string[];
}

export type ArtifactKind =
  | 'wrapped_phase_frame'      // 原相位像素（包裹相位）
  | 'amplitude_frame'          // 振幅
  | 'quality_score_map'        // 信噪评分
  | 'invalid_mask'             // 无效遮罩
  | 'wavelength_spec'          // 波长（版本化）
  | 'illumination_geometry'    // 入射几何
  | 'calibration_plane'        // 标定面
  | 'cut_edit_history'         // 切口编辑历史
  // ---- 派生 ----
  | 'residue_map'
  | 'cut_network'
  | 'unwrap_candidate'
  | 'cycle_residuals'
  | 'height_map'
  | 'height_chain_step';

export const INPUT_KINDS: ArtifactKind[] = [
  'wrapped_phase_frame', 'amplitude_frame', 'quality_score_map', 'invalid_mask',
  'wavelength_spec', 'illumination_geometry', 'calibration_plane', 'cut_edit_history'
];

export const IMMUTABLE_INPUT_KINDS: ArtifactKind[] = [
  'wrapped_phase_frame', 'amplitude_frame', 'quality_score_map', 'invalid_mask',
  'wavelength_spec', 'illumination_geometry', 'calibration_plane', 'cut_edit_history'
];

export type InputKind = typeof INPUT_KINDS[number];

export interface FrameTile {
  kind: ArtifactKind;
  unit: Unit;
  rows: number;
  cols: number;
  // 行优先；null 表示缺失/无法转换（保留在原位，附诊断），数字保留原始表示
  values: (number | null)[];
  diagnostics?: Diagnostic[];
}

export interface WavelengthSpec {
  wavelength: Quantity;             // 米（或原始单位）
  effectiveWavelengthFormula: string; // 例如 "lambda / 2"（反射式）或 "lambda / (cos θ1 + cos θ2)"
  formulaVersion: string;
}

export interface IlluminationGeometry {
  kind: GeometryKind;
  illuminationAngleDeg: Quantity;   // 相对表面法线
  observationAngleDeg: Quantity;
  sensitivityFormula: string;       // Δh = λ / (cosθi + cosθo) · Δφ / 2π
  formulaVersion: string;
}

export interface CalibrationPlane {
  planeEquation: string;            // 例如 "z = a*x + b*y + c"
  coefficients: Record<string, Quantity>;
  residualRms: Quantity;
  calibrationFrameRef?: string;     // 标定帧引用（外部帧标签）
}

export interface CutEdit {
  editId: string;
  action: 'add_cut' | 'remove_cut' | 'pin_offset' | 'unpin';
  edge?: [[number, number], [number, number]];
  integerOffset?: number;
  reason: string;
  operator: string;
}

export interface CutEditHistoryPayload {
  edits: CutEdit[];
}

export interface ResidueCell {
  row: number;
  col: number;
  charge: -1 | 1 | 0;          // ±1 残差点，0 一致；未知用 -2（见 unknown）
  unknown?: boolean;
  wrappedSumRad: number | null;
  sources: Record<string, number>; // 依赖的输入片段身份 -> 输入版本号
}

export interface ResidueMapPayload {
  rows: number;
  cols: number;
  cells: ResidueCell[];
}

export interface CutEdge {
  id: string;
  a: [number, number];
  b: [number, number];
  integerOffset: number | null;  // 切口两侧整周偏移，显式表示；null = 未裁定（禁止猜测）
  pinned: boolean;
  sourceEditId?: string;
  rejectedOffsets?: { offset: number; reason: string }[];
}

export interface CutNetworkPayload {
  edges: CutEdge[];
  pairing: { plus: [number, number]; minus: [number, number]; reason: string }[];
  boundaryCuts: [[number, number], [number, number]][];
}

export interface UnwrapTreeNode {
  cell: [number, number];
  parent: [number, number] | null;
  wrappedDiffRad: number;
  integerStep: number;       // ∇k
  unwrappedRad: number | null; // null = 低振幅/无效，保留未知
  held?: boolean;
}

export interface UnwrapCandidatePayload {
  candidateId: string;
  status: 'legal' | 'adopted' | 'rejected';
  rejectReason?: string;
  treeRoot: [number, number];
  componentSeeds: [number, number][];
  componentOffsets: Record<string, number>; // 多连通区整周偏移
  ambiguity: 'unique' | 'multi';
  ambiguityNote?: string;
  nodes: UnwrapTreeNode[];
  cycles: CycleResult[];
  algorithmVersion: string;
  parameterFingerprint: string;
  affectedByLockConflict?: boolean;
}

export interface CycleResult {
  cycleId: string;
  path: [number, number][];           // 闭合路径（首尾相同）
  wrappedSumRad: number | null;
  integerSum: number | null;
  residualRad: number | null;         // 循环残差
  closed: boolean;
  crossesCut: boolean;
  unknownEdges: number;
}

export interface CycleResidualsPayload {
  cycles: CycleResult[];
}

export interface HeightMapCell {
  row: number;
  col: number;
  height: number | null;              // 米；未知不猜
  unwrappedRadRef: string;            // 直接来源（候选身份）
  status: 'ok' | 'held_low_amplitude' | 'masked' | 'stale' | 'unconvertible';
}

export interface HeightMapPayload {
  rows: number;
  cols: number;
  cells: HeightMapCell[];
  wavelengthRef: string;
  geometryRef: string;
  calibrationRef: string;
  unwrapCandidateRef: string;
}

export interface ChainStep {
  stepId: string;
  label: 'wrapped_to_unwrapped' | 'phase_to_opd' | 'opd_to_height' | 'plane_reference';
  formula: string;
  inputs: Record<string, string>;      // 参数名 -> 实体身份
  coefficient: Quantity | null;        // 无法转换时 null + 诊断
  outputUom: string;
}

export interface HeightChainStepPayload extends ChainStep {
  stepIndex: number;
}

export interface ArtifactRef {
  kind: ArtifactKind;
  id: string;          // 稳定内容身份
  version: number;     // 该 kind 血缘中的版本号
  summary: string;     // 内容摘要
}

export interface Artifact {
  id: string;                       // 内容身份（哈希），跨导出/导入稳定
  kind: ArtifactKind;
  lineage: string;                  // 血缘键（通常是 kind；多片段可加 tag）
  version: number;
  parentId: string | null;
  title: string;
  summary: string;
  basis?: CoordinateBasis;
  frame?: FrameTile;                // 栅格类输入
  wavelength?: WavelengthSpec;
  geometry?: IlluminationGeometry;
  calibration?: CalibrationPlane;
  cutHistory?: CutEditHistoryPayload;
  residue?: ResidueMapPayload;
  cuts?: CutNetworkPayload;
  unwrap?: UnwrapCandidatePayload;
  cycles?: CycleResidualsPayload;
  height?: HeightMapPayload;
  chainStep?: HeightChainStepPayload;
  algorithmVersion?: string;
  parameterFingerprint?: string;
  directSources: ArtifactRef[];      // 直接来源（缺失引用 = 损坏）
  diagnostics: Diagnostic[];
  createdAtVirtual: number;          // 虚拟时钟序号（单调）
}

// ---------- 事件（只追加） ----------

export type EventType =
  | 'project_created'
  | 'input_committed'                 // 原相位/振幅/遮罩/波长/几何/标定/切口史 提交（不可覆盖）
  | 'analysis_run'                    // 计算：残差/切口/候选/循环/高度链
  | 'candidate_decision'              // 采纳 / 拒绝候选
  | 'local_lock'                      // 锁定局部解读
  | 'lock_resolution'                 // 冲突解决
  | 'review_decision'                 // 复核接受 / 否定 / 参数调整
  | 'undo'                            // 撤销（也写入历史）
  | 'archive_judgment'                // 反例档案的机器可读判断
  | 'corruption_detected';

export interface InputCommitEventData {
  artifactId: string;
  kind: InputKind;
  version: number;
  parentId: string | null;
  rawRepresentationKept: true;
}

export interface AnalysisRunEventData {
  runId: string;
  parameterFingerprint: string;
  algorithmVersion: string;
  produced: ArtifactRef[];
  directSourceRefs: ArtifactRef[];
  scenarios: string[];               // 本次经过的情形（边界跨越/低振幅孔洞/…）
}

export interface CandidateDecisionData {
  candidateId: string;
  decision: 'adopt' | 'reject';
  reason: string;
}

export interface LocalLockData {
  cell: [number, number];
  candidateId: string;
  lockedUnwrappedRad: number;
  conflictsWith?: { candidateId: string; value: number };
}

export interface LockResolutionData {
  cell: [number, number];
  resolution: 'keep_first' | 'override' | 'release';
  winnerCandidateId: string | null;
}

export interface ReviewDecisionData {
  scope: 'project' | 'cell' | 'candidate' | 'cut';
  target?: string;
  cell?: [number, number];
  decision: 'accept' | 'reject' | 'parameter_adjust';
  newParameterFingerprint?: string;
  note: string;
}

export interface UndoData {
  undoneEventId: string;
  reversal: boolean;
}

export interface ArchiveJudgmentData {
  archiveId: string;
  scenario: string;
  bundle: 'minimal' | 'combined';
  basis: string[];                    // 判断依据（机器可读）
  adoptedArtifactIds: string[];
  rejectedArtifactIds: { id: string; reason: string }[];
  changeScopeCoordinates?: [number, number][];
  sharedImmutableFragmentIds: string[];
}

export interface CorruptionData {
  missingRef: string;
  referrer: string;
}

export type EventData =
  | InputCommitEventData
  | AnalysisRunEventData
  | CandidateDecisionData
  | LocalLockData
  | LockResolutionData
  | ReviewDecisionData
  | UndoData
  | ArchiveJudgmentData
  | CorruptionData;

export interface LedgerEvent {
  id: string;
  seq: number;
  type: EventType;
  atVirtual: number;
  data: EventData;
  parentEventId: string | null;
}
