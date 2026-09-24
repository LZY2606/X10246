/**
 * 领域数据契约 —— 直接采用干涉测量自己的词汇，而不是泛化的 name/value。
 *
 * 三类概念：
 *  1) 输入实体（原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史）
 *     —— 一经提交不可覆盖（immutable），修订以新版本 + 父版本关系表达。
 *  2) 决定实体 —— 表达“低振幅不得猜相位 / 切口两侧整周偏移显式 / 展开树路径与循环残差”。
 *  3) 复核实体 —— 支撑并排复核（包裹/展开相位、质量图、切口网络、循环残差、高度链）与局部锁定。
 *
 * 所有领域量携带单位或坐标基准；原始表示保留在 raw 层，派生层才规范化。
 */

export type Unit =
  | "radian:[-pi,pi]"        // 原始包裹相位，保留仪器原始表示
  | "radian:unwrapped"       // 展开相位（派生）
  | "dimensionless"          // 归一化振幅 / 质量
  | "nm" | "um" | "mm" | "m" // 波长、高度（按原始单位保留）
  | "degree" | "radian"      // 入射角
  | "index" | "pixel" | "count";

export type CoordinateBasis = "pixel:row-col" | "pixel:x-y" | "world:mm";

export type Vec2 = [number, number];

/** 带单位/基准的领域量：导入时保留原始表示，无法规范化时留在原位置并附诊断。 */
export interface Dimensioned<T = number> {
  value: T;
  unit: Unit;
  basis?: CoordinateBasis;
  /** 规范化失败时给出原因，原值仍保留在 value 中，不丢弃。 */
  normalizationDiagnostic?: string;
}

/** 二维网格载体（行优先）。所有像素层实体共用形状以便并排对齐显示。 */
export interface Grid {
  rows: number;
  cols: number;
  values: number[];
  unit: Unit;
  basis: CoordinateBasis;
}

/** 像素位置（稳定寻址键 row:col）。 */
export type PixelKey = string;
export const px = (r: number, c: number): PixelKey => `${r}:${c}`;

// ---------------------------------------------------------------------------
// 1) 输入实体（不可变基线，七种）
// ---------------------------------------------------------------------------

export type InputKind =
  | "wrappedPhaseFrame"   // 原相位像素（+振幅，同帧仪器原始表示）
  | "snrMap"              // 信噪评分
  | "invalidMask"         // 无效遮罩
  | "wavelength"          // 波长
  | "illuminationGeometry"// 入射几何
  | "calibrationPlane"    // 标定面
  | "cutEditHistory";     // 切口编辑历史（操作者审计链，本身不可覆盖、只能追加新版本）

export interface WrappedPhaseFramePayload {
  kind: "wrappedPhaseFrame";
  wrappedPhase: Grid;              // radian:[-pi,pi]，原始表示
  amplitude: Grid;                 // dimensionless，振幅/亮度
  instrument?: string;             // 原始仪器标识（保留原样）
  acquisitionNote?: string;        // 原始备注，不做清洗
}

export interface SnrMapPayload {
  kind: "snrMap";
  snr: Grid;                       // dimensionless，每像素信噪评分
}

export interface InvalidMaskPayload {
  kind: "invalidMask";
  invalid: Grid;                   // 0/1，1 表示无效
  reasonNote?: string;
}

export interface WavelengthPayload {
  kind: "wavelength";
  lambda: Dimensioned<number>;     // nm/um/mm/m，保留原始单位
  /** 版本标签由操作者显式给出（波长版本变更）。 */
  versionLabel: string;
}

export interface IlluminationGeometryPayload {
  kind: "illuminationGeometry";
  incidence: Dimensioned<number>;  // degree/radian，入射角（保留原始单位）
  azimuth: Dimensioned<number>;
  model: "normal-incidence" | "oblique-plane-wave";
}

export interface CalibrationPlanePayload {
  kind: "calibrationPlane";
  /** z = a*x + b*y + c，世界坐标基准 */
  a: Dimensioned<number>;
  b: Dimensioned<number>;
  c: Dimensioned<number>;
  residualRms: Dimensioned<number>;
  fittedAt: string;
}

/** 切口编辑历史：仅允许追加的审计记录（每次编辑是一条不可改事件）。 */
export interface CutEditRecord {
  at: string;                      // 虚拟时间 ISO
  editor: string;
  action: "add-cut" | "remove-cut" | "reset";
  a: Vec2;                         // [row,col]
  b: Vec2;
}

export interface CutEditHistoryPayload {
  kind: "cutEditHistory";
  records: CutEditRecord[];
}

export type InputPayload =
  | WrappedPhaseFramePayload
  | SnrMapPayload
  | InvalidMaskPayload
  | WavelengthPayload
  | IlluminationGeometryPayload
  | CalibrationPlanePayload
  | CutEditHistoryPayload;

// ---------------------------------------------------------------------------
// 2) 决定实体（把领域原则变成一等数据）
// ---------------------------------------------------------------------------

export type ResidueCharge = 1 | -1 | 0;

export interface Plaquette {
  at: Vec2;                        // 左上角 [r,c]
  wrap: number;                    // 环绕数（charge）
  cycleResidual: Dimensioned<number>; // 沿 2x2 回路的残差（弧度）
  members: PixelKey[];
}

export interface QualityPixel {
  at: PixelKey;
  quality: number;                 // 0..1
  factors: { amplitude: number; snr: number; residuePenalty: number };
}

/** 切口网络中的一条支路（边）。两侧整周偏移必须显式表示。 */
export interface CutEdge {
  id: string;                      // 稳定支路身份，如 edge@2:3-2:4
  a: PixelKey;
  b: PixelKey;
  enforced: boolean;              // 是否为操作者/算法放置的切口
  /** 切口两侧的整周偏移（cycles）。未决定时为 unknown，绝不猜测。 */
  cycleOffset: number | "unknown";
  reason: "residue-pair" | "manual" | "low-amplitude-void" | "region-boundary";
}

/** 展开树：局部一致解；保留路径与循环残差。 */
export interface UnwrapTree {
  root: PixelKey;
  edges: Array<{ parent: PixelKey; child: PixelKey; edgeId: string; cycles: number }>;
  path: PixelKey[][];              // 每条非树边对应的树路径
  cycleResiduals: Array<{ loop: PixelKey[]; residual: number; closes: boolean; tolerance: number }>;
}

/** 整周候选：无法唯一决定时保留全部合法候选；拒绝原因作为一等数据。 */
export interface IntegerCycleCandidate {
  candidateId: string;
  perEdge: Record<string, number>; // edgeId -> 整周数
  consistency: "locally-consistent" | "inconsistent";
  cycleResidualMax: number;
  rejectedReasons?: string[];
  adopted?: boolean;
}

export type UnknownPixel =
  | { at: PixelKey; state: "no-guess"; reason: "low-amplitude" | "masked" | "unreliable"; evidence: { amplitude: number; snr: number; masked: boolean } };

export interface HeightSurface {
  height: Grid;                    // 派生高度（波长单位转换后）
  chain: HeightConversionStep[];   // 高度转换链，逐步可追溯
}

export interface HeightConversionStep {
  step: number;
  operation: string;              // 如 "unwrapped rad -> cycles -> lambda/4pi -> geometry"
  formula: string;
  inputsRef: string[];            // 引用的实体版本
  wavelengthVersionLabel: string;
  geometryModel: string;
  factor: number;
}

export type DerivedKind =
  | "qualityMap"
  | "residueMap"
  | "cutNetwork"
  | "unwrapTreeSet"
  | "heightSurface"
  | "diagnosticReport";

export interface QualityMapPayload {
  kind: "qualityMap";
  pixels: QualityPixel[];
  algorithmVersion: string;
  parameterFingerprint: string;
}

export interface ResidueMapPayload {
  kind: "residueMap";
  plaquettes: Plaquette[];
  positiveCount: number;
  negativeCount: number;
}

export interface CutNetworkPayload {
  kind: "cutNetwork";
  edges: CutEdge[];
  tree: UnwrapTree;
  candidates: IntegerCycleCandidate[];
  selectedCandidateId?: string;
  unknownPixels: UnknownPixel[];
}

export interface UnwrapTreeSetPayload {
  kind: "unwrapTreeSet";
  connectedComponents: number;
  trees: Array<{ componentId: number; tree: UnwrapTree }>;
  /** 多连通区/循环不闭合诊断。 */
  openCycles: Array<{ loop: PixelKey[]; residual: number; tolerance: number }>;
}

export interface HeightSurfacePayload extends HeightSurface {
  kind: "heightSurface";
  algorithmVersion: string;
  parameterFingerprint: string;
  /** 波长/几何过期时的标记：高度仍可查看，但不能冒充当前结果。 */
  basedOnWavelengthVersion: string;
}

export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "unknown";
  message: string;
  at?: PixelKey;
  value?: number;
  expectedUnit?: Unit;
}

export interface DiagnosticReportPayload {
  kind: "diagnosticReport";
  diagnostics: Diagnostic[];
  /** 无法转换、保留原位置的值。 */
  unconverted: Array<{ ref: string; raw: unknown; reason: string }>;
}

export type DerivedPayload =
  | QualityMapPayload
  | ResidueMapPayload
  | CutNetworkPayload
  | UnwrapTreeSetPayload
  | HeightSurfacePayload
  | DiagnosticReportPayload;

// ---------------------------------------------------------------------------
// 实体信封：稳定身份 + 版本 + 来源 + 内容摘要
// ---------------------------------------------------------------------------

export type EntityKind = InputKind | DerivedKind;

export interface SourceRef {
  entityId: string;
  version: number;
  /** 内容摘要，解析引用时必须核对；不一致即损坏。 */
  digest: string;
  role: string;                     // 该来源在计算中的角色
}

export interface Entity<P = unknown> {
  id: string;                       // 稳定身份（导出/删除/导入保持）
  kind: EntityKind;
  version: number;                  // 同一 id 流上的版本号
  lineageId: string;               // 同一逻辑流（如 wavelength）跨版本共享
  parentId: string | null;          // 父版本实体 id
  status: "current" | "stale" | "superseded";
  immutable: boolean;
  createdAt: string;
  algorithmVersion?: string;
  parameterFingerprint?: string;
  sources: SourceRef[];             // 直接来源；缺引用 => 损坏，不退回最新版
  payloadDigest: string;
  payload: P;
  /** 该实体对哪些像素/区域生效（局部依赖失效）。 */
  scopePixelKeys?: PixelKey[];
}

// ---------------------------------------------------------------------------
// 机器可读事件（采纳/未采纳、冲突、撤销、时间旅行）
// ---------------------------------------------------------------------------

export type EventType =
  | "input.committed"
  | "input.revised"
  | "derived.computed"
  | "candidate.proposed"
  | "candidate.adopted"
  | "candidate.rejected"
  | "cut.edited"
  | "local.locked"
  | "local.unlocked"
  | "lock.conflict"
  | "decision.accepted"
  | "decision.rejected"
  | "parameter.adjusted"
  | "undone"
  | "scenario.evaluated"
  | "corruption.detected"
  | "project.exported"
  | "project.imported";

export interface LedgerEvent {
  seq: number;
  id: string;                       // evt-<seq>-<hash7>
  at: string;
  type: EventType;
  actor: string;
  /** 当时锁定可见的依赖版本（时间旅行依据）。 */
  refs: SourceRef[];
  payload: Record<string, unknown>;
  /** 采纳与未采纳结果都保留：outcome 允许 undecided/rejected。 */
  outcome?: "adopted" | "rejected" | "undecided";
  parentEventHash: string;          // 哈希链
  eventHash: string;
}

/** 局部锁定：把某像素的解读固定到具体候选与依赖版本。 */
export interface LocalLock {
  at: PixelKey;
  candidateId: string;
  cutEdgeId?: string;
  cycleOffset?: number;
  refs: SourceRef[];
  lockedAt: string;
  lockedBy: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// 反例档案（七个情形：最小输入 + 组合输入，共享片段只存一份）
// ---------------------------------------------------------------------------

export type ScenarioKey =
  | "phase-boundary-crossing"
  | "low-amplitude-void"
  | "multiply-connected-region"
  | "cycle-nonclosure"
  | "wavelength-version-change"
  | "integer-cycle-ambiguity"
  | "local-lock-conflict";

export interface ScenarioCase {
  key: ScenarioKey;
  title: string;
  principle: string;                // 对应的判断依据（人读）
  minimalInputId: string;           // 最小输入提交 id
  combinedInputId: string;          // 组合输入提交 id
  sharedFragmentDigests: string[];  // 两者共享、只存一份的不可变片段
  minimalInterpretationVersion: number;
  combinedInterpretationVersion: number;
  failureDiagnosis: string[];
  adoptedResults: string[];
  unadoptedResults: string[];
  machineEventIds: string[];        // 机器可读判断依据事件
  status: "baseline" | "triggered" | "adjudicated";
}

export interface ProjectManifest {
  projectId: string;
  schemaVersion: number;
  createdAt: string;
  casePack: string;                 // 离线案例包标识
}
