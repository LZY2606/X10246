import type { Frame2D, PixelCoord, Quantity } from "../shared/units.js";

/* ============ 输入实体（原相位像素、信噪评分、无效遮罩、波长、入射几何、标定面、切口编辑历史，均不可覆盖） ============ */

export interface WrappedPhaseField {
  kind: "wrapped-phase-field";
  frame: Frame2D;
  /** 包裹相位，单位 rad，范围 (-π, π]；行优先展开。 */
  phaseRad: number[];
}

export interface AmplitudeQualityMap {
  kind: "amplitude-quality-map";
  frame: Frame2D;
  /** 归一化振幅/信噪评分 [0,1]。 */
  snrScore: number[];
  /** 低于该阈值的区域不得猜相位。 */
  guessFloor: number;
}

export interface InvalidMask {
  kind: "invalid-mask";
  frame: Frame2D;
  /** true = 无效像素。 */
  invalid: boolean[];
}

export interface WavelengthSpec {
  kind: "wavelength-spec";
  wavelength: Quantity; // nm / um / mm
  source: string; // 例如 "HeNe 激光器铭牌"
}

export interface IncidentGeometry {
  kind: "incident-geometry";
  incidenceAngle: Quantity; // deg
  mode: "reflection" | "transmission";
}

export interface CalibrationPlane {
  kind: "calibration-plane";
  /** 标定面拟合系数：z = a*x + b*y + c，单位 um。 */
  tiltX: Quantity;
  tiltY: Quantity;
  offset: Quantity;
}

export type CutEdit =
  | { op: "add-cut"; cutId: string; path: PixelCoord[] }
  | { op: "remove-cut"; cutId: string };

export interface CutEditHistory {
  kind: "cut-edit-history";
  edits: CutEdit[];
}

export type InputPayload =
  | WrappedPhaseField
  | AmplitudeQualityMap
  | InvalidMask
  | WavelengthSpec
  | IncidentGeometry
  | CalibrationPlane
  | CutEditHistory;

export type InputKind = InputPayload["kind"];

export const INPUT_KINDS: InputKind[] = [
  "wrapped-phase-field",
  "amplitude-quality-map",
  "invalid-mask",
  "wavelength-spec",
  "incident-geometry",
  "calibration-plane",
  "cut-edit-history",
];

/* ============ 版本与来源 ============ */

export interface EntityVersion<T = InputPayload> {
  entityId: string;
  versionId: string;
  parentVersionId: string | null;
  kind: InputKind;
  payload: T;
  digest: string;
  createdAt: string;
}

/** 派生值的直接来源：实体 + 版本 + 内容摘要，缺一不可。 */
export interface SourceRef {
  entityId: string;
  versionId: string;
  digest: string;
}

/* ============ 决定实体（候选、切口整周偏移、展开树、循环残差、局部锁） ============ */

/** 切口两侧的整周偏移显式表示。 */
export interface CutSideOffset {
  cutId: string;
  side: "left" | "right";
  integerOffsetK: number;
}

export interface CycleResidual {
  loopId: string;
  cells: PixelCoord[];
  residualRad: number;
  closed: boolean;
}

export type PixelState = "unwrapped" | "unknown-low-amplitude" | "masked" | "cut-blocked";

export interface UnwrappedSolution {
  /** 每像素整周数 k；null 表示未解（低振幅/遮罩），绝不猜测。 */
  integerField: (number | null)[];
  pixelStates: PixelState[];
  seed: PixelCoord;
  treePath: PixelCoord[]; // 展开树生长顺序，需保留
}

export interface UnwrapCandidate {
  candidateId: string;
  treeLabel: string;
  solution: UnwrappedSolution;
  cutOffsets: CutSideOffset[];
  cycleResiduals: CycleResidual[];
  status: "valid" | "rejected" | "ambiguous";
  rejectionReasons: string[];
  /** 整周多解：同一局部一致解族的全局 k 偏移。 */
  globalOffsetK: number;
}

export interface HeightMap {
  kind: "height-map";
  frame: Frame2D;
  /** 表面高度，单位 um；未知像素为 null。 */
  heightUm: (number | null)[];
  formula: string;
}

export interface LocalLock {
  lockId: string;
  region: PixelCoord[];
  candidateId: string;
  rationale: string;
}

/* ============ 复核/判断事件（机器可读） ============ */

export type JudgmentCode =
  | "NO_GUESS_LOW_AMPLITUDE" // 低振幅区域不得猜相位
  | "EXPLICIT_CUT_OFFSET" // 切口两侧整周偏移显式表示
  | "TREE_LOCAL_CONSISTENCY" // 不同展开树可局部一致，保留路径与循环残差
  | "IMPACT_SCOPED"; // 单一来源变更的影响被限制在正确范围

export interface Judgment {
  code: JudgmentCode;
  subject: string; // 稳定身份
  detail: string;
}
