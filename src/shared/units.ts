// 领域量与单位、坐标基准。所有领域量都携带单位或坐标基准；
// 导入时保留原始表示，派生层才做规范化；无法转换的值留在原位置并附诊断。

export type AngleUnit = "rad" | "deg" | "turn";
export type LengthUnit = "nm" | "um" | "mm" | "m";
export type DimensionlessUnit = "ratio" | "percent" | "dn";

export type UnitKind = "angle" | "length" | "dimensionless";

export const UNIT_KIND: Record<string, UnitKind> = {
  rad: "angle",
  deg: "angle",
  turn: "angle",
  nm: "length",
  um: "length",
  mm: "length",
  m: "length",
  ratio: "dimensionless",
  percent: "dimensionless",
  dn: "dimensionless",
};

export interface Quantity<U extends string = string> {
  /** 原始数值，保留导入时的表示（不丢精度，不擅自换算后覆盖）。 */
  value: number;
  /** 原始单位；规范化只在派生层发生。 */
  unit: U;
  /** 派生层规范化后的数值（基准单位），无法转换时为 null。 */
  normalized?: number | null;
  /** 无法转换/越界等诊断，保留在原位而不是丢弃。 */
  diagnostic?: string;
}

const ANGLE_TO_RAD: Record<AngleUnit, number> = {
  rad: 1,
  deg: Math.PI / 180,
  turn: 2 * Math.PI,
};

const LENGTH_TO_M: Record<LengthUnit, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1,
};

const DIM_TO_RATIO: Record<DimensionlessUnit, number> = {
  ratio: 1,
  percent: 0.01,
  dn: 1 / 65535,
};

export function normalizeQuantity(q: Quantity): number | null {
  if (typeof q.value !== "number" || !Number.isFinite(q.value)) return null;
  if (q.unit in ANGLE_TO_RAD) return q.value * ANGLE_TO_RAD[q.unit as AngleUnit];
  if (q.unit in LENGTH_TO_M) return q.value * LENGTH_TO_M[q.unit as LengthUnit];
  if (q.unit in DIM_TO_RATIO) return q.value * DIM_TO_RATIO[q.unit as DimensionlessUnit];
  return null;
}

/** 坐标基准：每个光栅都必须说明行列坐标的物理基准。 */
export interface CoordinateFrame {
  id: string;
  name: string;
  /** 像素间距（行列），带长度单位。 */
  pixelPitch: { row: Quantity<LengthUnit>; col: Quantity<LengthUnit> };
  /** 原点像素索引（行、列）。 */
  origin: { row: number; col: number };
  axisConvention: "row-down-col-right";
}
