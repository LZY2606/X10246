/**
 * 干涉条纹簿 · 领域数据契约
 *
 * 设计原则：
 * - 直接采用光学干涉 / 相位展开 / 标定领域自身词汇，不把领域量压成 name/value。
 * - 输入实体（原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史）
 *   一经提交即不可变；修订以新版本 + 父版本关系表达。
 * - 派生实体携带算法版本、参数指纹与直接来源（SourceRef）。
 * - 任何引用都可解析到具体版本；缺引用即“损坏”，不允许退回最新版。
 */

export type Unit =
  | "rad"
  | "nm"
  | "adu"
  | "dimensionless"
  | "boolean"
  | "cycle"
  | "pixel";

/** 坐标基准：所有行列像素都可换算到物理坐标 */
export interface CoordBasis {
  id: string;
  name: string;
  /** 每像素对应的物理尺寸 */
  pixelPitchNm: number;
  /** 原点像素 (row,col) 对应物理坐标 (xNm,yNm) */
  originNm: [number, number];
  axisConvention: "row->y,col->x";
}

export type ScenarioKind =
  | "phase-boundary-crossing"
  | "low-amplitude-hole"
  | "multiply-connected-region"
  | "cycle-non-closing"
  | "wavelength-version-change"
  | "integer-ambiguity"
  | "local-lock-conflict";

export interface Diagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  at?: { row: number; col: number };
  message: string;
}

/** 不可变原始片段：最小输入与组合输入共享同一份内容时只存一份 */
export interface RawFragment {
  fragmentId: string;
  kind: "phase-tile" | "amplitude-tile" | "quality-tile" | "mask-tile";
  rows: number;
  cols: number;
  unit: Unit;
  values: (number | null)[][];
  /** 无法转换为数值的原始表示，留在原位置，绝不为画图丢弃 */
  unconvertible?: { row: number; col: number; raw: string; reason: string }[];
}

export interface FrameProvenance {
  /** 本帧由哪些不可变片段拼成（片段按内容寻址，天然只存一份） */
  composition: { fragmentId: string; offsetRow: number; offsetCol: number }[];
}

interface FrameBase {
  id: string;
  version: number;
  parentId: string | null;
  rows: number;
  cols: number;
  coordBasisId: string;
  unit: Unit;
  /** null 表示无效/未知/不可转换，原位置保留在 unconvertible 中 */
  values: (number | null)[][];
  unconvertible: { row: number; col: number; raw: string; reason: string }[];
  provenance: FrameProvenance;
  committedAtVirtualMs: number;
}

export interface WrappedPhaseFrame extends FrameBase {
  kind: "wrapped-phase-frame";
  wrapRange: "[-pi,pi)";
}

export interface AmplitudeFrame extends FrameBase {
  kind: "amplitude-frame";
}

export interface QualityScoreMap extends FrameBase {
  kind: "quality-score-map";
  scoreModel: string;
}

export interface InvalidMask extends FrameBase {
  kind: "invalid-mask";
  /** 1 = 无效（低振幅/遮挡/传感器缺陷），0 = 有效 */
  invalidReasons: (string | null)[][];
}

export interface Wavelength {
  id: string;
  kind: "wavelength";
  version: number;
  parentId: string | null;
  channel: string;
  valueNm: number | null;
  unit: "nm";
  unconvertible: { raw: string; reason: string }[];
  committedAtVirtualMs: number;
}

export interface IlluminationGeometry {
  id: string;
  kind: "illumination-geometry";
  version: number;
  parentId: string | null;
  coordBasisId: string;
  /** 入射角（与表面法线夹角），弧度 */
  incidenceAngleRad: number;
  /** 入射面方位角，弧度（col 轴为 0） */
  azimuthRad: number;
  angleUnit: "rad";
  committedAtVirtualMs: number;
}

/** 标定面 z = a + bx + cy（x,y 单位 nm，z 单位 nm） */
export interface CalibrationPlane {
  id: string;
  kind: "calibration-plane";
  version: number;
  parentId: string | null;
  coordBasisId: string;
  coefficients: { aNm: number; bSlope: number; cSlope: number };
  residualNm: number;
  committedAtVirtualMs: number;
}

export interface CutEditEntry {
  edge: { r1: number; c1: number; r2: number; c2: number };
  action: "add-cut" | "remove-cut";
  reason: string;
  atVirtualMs: number;
}

export interface CutEditHistory {
  id: string;
  kind: "cut-edit-history";
  version: number;
  parentId: string | null;
  entries: CutEditEntry[];
  committedAtVirtualMs: number;
}

export type RawEntity =
  | WrappedPhaseFrame
  | AmplitudeFrame
  | QualityScoreMap
  | InvalidMask
  | Wavelength
  | IlluminationGeometry
  | CalibrationPlane
  | CutEditHistory;

export type RawEntityKind = RawEntity["kind"];

/** 直接来源引用：始终指向某个具体版本 id，绝不隐式指向“最新版” */
export interface SourceRef {
  kind: RawEntityKind | DerivedEntityKind;
  id: string;
  version: number;
  /** 内容摘要，查询实体时一并返回；导入时可据此校验 */
  digest: string;
}

export interface AlgorithmRef {
  algorithm: string;
  algorithmVersion: string;
  paramFingerprint: string;
  params: Record<string, unknown>;
  seed: number;
}

export type UnknownReason =
  | "low-amplitude"
  | "invalid-mask"
  | "unconvertible-input"
  | "cut-blocked"
  | "disconnected";

export interface NormalizedPhaseFrame {
  id: string;
  kind: "normalized-phase-frame";
  sources: { wrapped: SourceRef };
  algorithm: AlgorithmRef;
  rows: number;
  cols: number;
  unit: "rad";
  /** 规范化相位，未知像素为 null */
  values: (number | null)[][];
  unknown: ({ row: number; col: number; reason: UnknownReason } | null)[][];
  diagnostics: Diagnostic[];
}

export interface QualityCell {
  row: number;
  col: number;
  score: number | null;
  amplitude: number | null;
  unknown: boolean;
  reason: UnknownReason | null;
}

export interface QualityMap {
  id: string;
  kind: "quality-map";
  sources: { amplitude: SourceRef; qualityScore: SourceRef; mask: SourceRef };
  algorithm: AlgorithmRef;
  cells: QualityCell[];
  rows: number;
  cols: number;
}

export interface Plaquette {
  row: number;
  col: number;
  charge: -1 | 0 | 1;
  wrapSum: number;
}

export interface ResidueMap {
  id: string;
  kind: "residue-map";
  sources: { normalized: SourceRef };
  algorithm: AlgorithmRef;
  plaquettes: Plaquette[];
  diagnostics: Diagnostic[];
}

export interface GraphEdge {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface RegionInfo {
  regionId: string;
  cells: { row: number; col: number }[];
}

export interface GapLink {
  linkId: string;
  kind: "gap" | "cut";
  edge: GraphEdge;
  sideA: { row: number; col: number; regionId: string };
  sideB: { row: number; col: number; regionId: string };
  /** 生成切口依据（残差对）或人工切口编辑来源 */
  basis: "residue-pair" | "unpaired-residue" | "manual-edit" | "invalid-gap";
}

export interface BranchCutNetwork {
  id: string;
  kind: "branch-cut-network";
  sources: { residue: SourceRef; quality: SourceRef; mask: SourceRef; cutHistory: SourceRef };
  algorithm: AlgorithmRef;
  regions: RegionInfo[];
  cutEdges: (GraphEdge & { basis: GapLink["basis"]; pairedPlaquettes?: string[] })[];
  links: GapLink[];
}

export interface TreePath {
  from: { row: number; col: number };
  to: { row: number; col: number };
  edges: GraphEdge[];
  wrappedSum: number;
  wrap2piCount: number;
}

export interface CycleResidual {
  cycleId: string;
  edges: GraphEdge[];
  /** 沿闭合循环的包裹差之和，单位 rad；0 表示闭合 */
  residualRad: number;
  residualCycles: number;
  closes: boolean;
  enclosesInvalid: boolean;
}

export interface UnwrapTree {
  id: string;
  kind: "unwrap-tree";
  sources: { normalized: SourceRef; network: SourceRef };
  algorithm: AlgorithmRef;
  variant: "A-primary" | "B-alternate";
  scope:
    | { kind: "region"; regionId: string }
    | { kind: "link"; linkId: string };
  root: { row: number; col: number };
  parentEdges: ({ child: { row: number; col: number }; edge: GraphEdge } | null)[][];
  paths: TreePath[];
  cycleResiduals: CycleResidual[];
  locallyConsistent: boolean;
}

export interface IntegerCandidate {
  candidateId: string;
  interpretationId: string;
  scope:
    | { kind: "region-base"; regionId: string }
    | { kind: "link"; linkId: string };
  /** 整周偏移 k（单位 cycle），侧B绝对相位 = 展开差 + 2πk */
  offsetK: number;
  unit: "cycle";
  status: "open" | "accepted" | "rejected";
  rejectionReasons: { code: string; message: string }[];
  sourceTreeIds: string[];
  cycleResidualId: string | null;
  note: string;
}

export interface OffsetAssignment {
  scope: IntegerCandidate["scope"];
  offsetK: number;
  candidateId: string;
}

export interface IntegerOffsetTable {
  id: string;
  kind: "integer-offset-table";
  sources: { trees: SourceRef[]; network: SourceRef };
  algorithm: AlgorithmRef;
  interpretationId: string;
  assignments: OffsetAssignment[];
  candidates: string[];
}

export interface HeightChainStep {
  step: string;
  sourceRef: SourceRef;
  digest: string;
  detail: string;
}

export interface SurfaceHeightMap {
  id: string;
  kind: "surface-height-map";
  sources: {
    offsetTable: SourceRef;
    normalized: SourceRef;
    wavelength: SourceRef;
    geometry: SourceRef;
    calibration: SourceRef;
  };
  algorithm: AlgorithmRef;
  interpretationId: string;
  rows: number;
  cols: number;
  unit: "nm";
  /** 高度；低振幅/被遮罩/未裁定像素保持 null，绝不猜 */
  values: (number | null)[][];
  chain: HeightChainStep[];
  diagnostics: Diagnostic[];
}

export type DerivedEntity =
  | NormalizedPhaseFrame
  | QualityMap
  | ResidueMap
  | BranchCutNetwork
  | UnwrapTree
  | IntegerOffsetTable
  | SurfaceHeightMap;

export type DerivedEntityKind = DerivedEntity["kind"];

export type EntityKind = RawEntityKind | DerivedEntityKind;

export type InterpretationStatus =
  | "pending"
  | "candidates-ready"
  | "decided"
  | "conflicted"
  | "stale";

/** 一次解释：固定一组直接来源版本 + 算法指纹，产出整套派生物 */
export interface Interpretation {
  interpretationId: string;
  scenarioKind: ScenarioKind;
  label: string;
  status: InterpretationStatus;
  sources: Record<string, SourceRef>;
  algorithm: AlgorithmRef;
  derived: Partial<Record<DerivedEntityKind, string>>;
  candidateIds: string[];
  diagnostics: Diagnostic[];
  createdAtVirtualMs: number;
  /** 被哪个源版本变更判定为过期；过期后仍可查看，但不得冒充当前结果 */
  staleBecause: { sourceKind: string; oldSourceId: string; newSourceId: string } | null;
}

/** 机器可读取的判断事件（判断依据结构化） */
export interface JudgmentBasis {
  code:
    | "LOW_AMPLITUDE_NO_GUESS"
    | "CUT_OFFSET_EXPLICIT"
    | "TREE_LOCAL_CONSISTENCY";
  subjectRefs: SourceRef[];
  evidence: Record<string, unknown>;
  ruleVersion: string;
}

export type LedgerEventType =
  | "project-created"
  | "raw-input-committed"
  | "interpretation-requested"
  | "candidate-produced"
  | "decision-recorded"
  | "judgment-recorded"
  | "local-lock-acquired"
  | "local-lock-released"
  | "local-lock-conflict"
  | "lock-conflict-resolved"
  | "cut-edit-committed"
  | "source-revision-committed"
  | "parameter-revision"
  | "derived-stale"
  | "undo-recorded"
  | "bundle-imported";

export interface LedgerEvent {
  eventId: string;
  seq: number;
  type: LedgerEventType;
  atVirtualMs: number;
  payload: Record<string, unknown>;
  /** 本事件依赖的全部具体版本引用；回放到此事件时只允许使用这些版本 */
  refs: SourceRef[];
  basis?: JudgmentBasis;
  undoOfEventId?: string;
}

export interface ProjectMeta {
  projectId: string;
  name: string;
  createdAtVirtualMs: number;
  seed: number;
}

export interface BundleExport {
  format: "interferometry-ledger-bundle";
  formatVersion: 1;
  exportedAtVirtualMs: number;
  project: ProjectMeta;
  fragments: RawFragment[];
  entities: RawEntity[];
  interpretations: Interpretation[];
  derived: DerivedEntity[];
  candidates: IntegerCandidate[];
  events: LedgerEvent[];
}

export class CorruptReferenceError extends Error {
  constructor(
    public readonly ref: { kind: string; id: string; version?: number },
    public readonly expectedDigest?: string
  ) {
    super(
      `损坏的引用：${ref.kind}#${ref.id}${ref.version != null ? `@v${ref.version}` : ""} 无法解析；不允许回退到最新版`
    );
    this.name = "CorruptReferenceError";
  }
}
