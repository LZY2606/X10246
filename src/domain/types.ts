/** 领域词汇的数据契约：输入/决定/复核实体直接使用本领域术语。 */
import type { Quantity } from "./units";

/** 输入实体种类：一经提交不可覆盖，修订以新版本 + 父版本表达。 */
export const INPUT_KINDS = [
  "wrapped_phase",        // 原相位像素（包裹相位）
  "snr_score",            // 信噪评分
  "invalid_mask",         // 无效遮罩
  "wavelength",           // 波长
  "incidence_geometry",   // 入射几何
  "calibration_surface",  // 标定面
  "cut_edit_history",     // 切口编辑历史
] as const;
export type InputKind = (typeof INPUT_KINDS)[number];

export const INPUT_KIND_LABELS: Record<InputKind, string> = {
  wrapped_phase: "原相位像素",
  snr_score: "信噪评分",
  invalid_mask: "无效遮罩",
  wavelength: "波长",
  incidence_geometry: "入射几何",
  calibration_surface: "标定面",
  cut_edit_history: "切口编辑历史",
};

/** 网格载荷：行主序，所有网格量共享坐标基准 sensor-pixel。 */
export interface GridPayload {
  width: number;
  height: number;
  frame: "sensor-pixel";
  unit: string;
  values: number[];
}

export interface WavelengthPayload {
  wavelength: Quantity; // 长度单位
  source: string;       // 例如 "laser-interpolated" / "calibration-frame"
}

export interface IncidenceGeometryPayload {
  incidenceAngle: Quantity; // 角度单位
  azimuth: Quantity;
  frame: "lab-frame";
}

export interface CalibrationSurfacePayload {
  reference: string; // 标定帧身份
  flatness: Quantity;
  frame: "surface-normal";
}

export interface CutEditEntry {
  edge: [number, number]; // 线性像素索引对
  action: "add-cut" | "remove-cut";
  reason: string;
}
export interface CutEditHistoryPayload {
  entries: CutEditEntry[];
}

export type InputPayload =
  | GridPayload
  | WavelengthPayload
  | IncidenceGeometryPayload
  | CalibrationSurfacePayload
  | CutEditHistoryPayload;

/** 七种验收情形。 */
export const SCENARIOS = [
  "phase-crossing-boundary", // 相位跨越边界
  "low-amplitude-hole",      // 低振幅孔洞
  "multi-connected-region",  // 多连通区
  "cycle-non-closure",       // 循环不闭合
  "wavelength-version-change", // 波长版本变更
  "integer-multi-solution",  // 整周多解
  "local-lock-conflict",     // 局部锁定冲突
] as const;
export type ScenarioKind = (typeof SCENARIOS)[number];

export const SCENARIO_LABELS: Record<ScenarioKind, string> = {
  "phase-crossing-boundary": "相位跨越边界",
  "low-amplitude-hole": "低振幅孔洞",
  "multi-connected-region": "多连通区",
  "cycle-non-closure": "循环不闭合",
  "wavelength-version-change": "波长版本变更",
  "integer-multi-solution": "整周多解",
  "local-lock-conflict": "局部锁定冲突",
};

/** 决定实体遵循的三条领域规则（机器可读）。 */
export const DECISION_RULES = {
  "no-guess-low-amplitude": "低振幅区域不得猜相位",
  "explicit-integer-offsets": "切口两侧的整周偏移要显式表示",
  "keep-paths-and-cycle-residuals": "不同展开树可得到局部一致解，需保留路径与循环残差",
} as const;
export type DecisionRule = keyof typeof DECISION_RULES;
