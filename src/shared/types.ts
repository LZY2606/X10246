/**
 * 干涉条纹簿 —— 领域数据契约
 *
 * 本文件只使用光学干涉 / 相位展开 / 标定领域自身的词汇：
 * 包裹相位像素(wrappedPhasePixel)、振幅(amplitude)、信噪评分(snrScore)、
 * 无效遮罩(invalidMask)、波长(wavelength)、入射几何(incidenceGeometry)、
 * 标定面(calibrationSurface)、支路切口(branchCut)、整周候选(integerCycleCandidate)、
 * 展开树(unwrappingTree)、循环残差(loopResidual)、表面高度(surfaceHeight)。
 *
 * 不使用 name/value 通用压缩结构。
 */

export type MaterialKind =
  | "wrappedPhaseFrame"
  | "amplitudeFrame"
  | "snrScoreFrame"
  | "invalidMaskFrame"
  | "wavelengthSpec"
  | "incidenceGeometry"
  | "calibrationSurface"
  | "branchCutEditHistory";

export type DerivedKind =
  | "qualityMap"
  | "residueMap"
  | "branchCutNetwork"
  | "connectedRegions"
  | "unwrappingTree"
  | "integerCycleCandidateSet"
  | "unwrappedPhaseField"
  | "loopResidualSet"
  | "heightConversionChain";

export type EventKind =
  | "materialCommitted"
  | "materialSuperseded"
  | "derivedProduced"
  | "derivedInvalidated"
  | "candidateAdjudicated"
  | "localInterpretationLocked"
  | "localInterpretationUnlocked"
  | "lockConflictDetected"
  | "parameterRevision"
  | "projectCreated"
  | "projectImported"
  | "diagnosticRecorded";

export type Adjudication = "accepted" | "rejected" | "deferred";
export type CandidateStatus = "legal" | "accepted" | "rejected";

/** 带单位 / 坐标基准的领域量。raw 保留导入时原始表示，派生层才规范化。 */
export interface Dimensioned {
  value: number;
  unit: string;
  raw?: string;
  basis?: string;
}

/** 网格坐标基准（原点、轴方向、像素间距），所有二维帧共享。 */
export interface GridBasis {
  rows: number;
  cols: number;
  origin: "upper-left";
  rowAxis: "down";
  colAxis: "right";
  pixelPitch: Dimensioned;
  coordinateSystem: string;
}

export interface FrameInput {
  grid: GridBasis;
  /** 长度 rows*cols，行优先；缺失值必须为 null，禁止猜值。 */
  cells: (number | null)[];
  /** 单位/值域说明，例如 radian[-pi,pi) */
  valueUnit: string;
  sourceRepresentation?: string;
}

export interface WrappedPhaseFrame extends FrameInput {}
export interface AmplitudeFrame extends FrameInput {}
export interface SnrScoreFrame extends FrameInput {}
export interface InvalidMaskFrame {
  grid: GridBasis;
  /** true = 无效像素（低振幅孔洞等） */
  invalid: boolean[];
  reasonPerCell?: (string | null)[];
}

export interface WavelengthSpec {
  wavelength: Dimensioned;
  /** 波长版本号；变更会产生新版本与父版本关系。 */
  specVersion: string;
  parentVersion?: string;
  mediumRefractiveIndex: number;
}

export interface IncidenceGeometry {
  /** 照明入射角，带角度基准 */
  incidenceAngle: Dimensioned;
  observationAngle: Dimensioned;
  geometryModel: "two-beam-interference";
}

export interface CalibrationSurface {
  /** 标定面方程 z = a*x + b*y + c（坐标基准随 grid） */
  planeCoefficients: { a: number; b: number; c: number };
  coefficientUnit: string;
  referenceWavelengthVersion: string;
  residualRms?: Dimensioned;
}

export interface BranchCutSegment {
  id: string;
  from: [number, number];
  to: [number, number];
  reason: "residue-pair" | "residue-to-border" | "manual";
}

export interface BranchCutEdit {
  editId: string;
  at: string;
  action: "add" | "remove";
  segment: BranchCutSegment;
  operatorNote?: string;
}

export interface BranchCutEditHistory {
  edits: BranchCutEdit[];
}

export type MaterialPayload =
  | { kind: "wrappedPhaseFrame"; data: WrappedPhaseFrame }
  | { kind: "amplitudeFrame"; data: AmplitudeFrame }
  | { kind: "snrScoreFrame"; data: SnrScoreFrame }
  | { kind: "invalidMaskFrame"; data: InvalidMaskFrame }
  | { kind: "wavelengthSpec"; data: WavelengthSpec }
  | { kind: "incidenceGeometry"; data: IncidenceGeometry }
  | { kind: "calibrationSurface"; data: CalibrationSurface }
  | { kind: "branchCutEditHistory"; data: BranchCutEditHistory };

export interface MaterialRef {
  materialId: string;
  version: number;
  contentDigest: string;
}

/** 已提交、不可覆盖的输入实体。 */
export interface Material extends MaterialRef {
  projectId: string;
  kind: MaterialKind;
  payload: unknown;
  parentId?: string;
  committedAt: string;
  /** 业务序号，重放 / 导出导入后稳定。 */
  seq: number;
}

export interface AlgorithmFingerprint {
  algorithm: string;
  algorithmVersion: string;
  parameterFingerprint: string;
  parameters: Record<string, unknown>;
}

export interface DirectSource {
  /** 引用必须精确到版本与内容摘要。 */
  refs: MaterialRef[];
  /** 上游派生结果（也带版本摘要）。 */
  derivedRefs?: { kind: DerivedKind; id: string; version: number; contentDigest: string }[];
}

export interface DerivedResult<T = unknown> {
  id: string;
  projectId: string;
  kind: DerivedKind;
  version: number;
  contentDigest: string;
  seq: number;
  producedAt: string;
  fingerprint: AlgorithmFingerprint;
  directSources: DirectSource;
  status: "current" | "stale";
  staleReason?: string;
  /** 使本结果过期的事件 id */
  invalidatedBy?: string;
  payload: T;
  diagnostics: Diagnostic[];
}

export interface Diagnostic {
  code:
    | "LOW_AMPLITUDE_HOLD"
    | "PHASE_BOUNDARY_WRAP"
    | "MULTIPLY_CONNECTED_REGION"
    | "LOOP_NOT_CLOSED"
    | "WAVELENGTH_VERSION_CHANGED"
    | "INTEGER_CYCLE_AMBIGUITY"
    | "LOCAL_LOCK_CONFLICT"
    | "UNCONVERTIBLE_VALUE"
    | "MISSING_REFERENCE"
    | "FORMAT_ERROR";
  severity: "info" | "warning" | "error";
  message: string;
  location?: { row: number; col: number } | { loopId: string } | { segmentId: string };
  evidence?: unknown;
}
