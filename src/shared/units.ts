/** 领域量：所有量都携带单位或坐标基准。原始表示在导入层保留，派生层才做规范化。 */

export type LengthUnit = "nm" | "um" | "mm";
export type AngleUnit = "rad" | "deg";

export interface Quantity<U extends string = string> {
  value: number;
  unit: U;
}

export interface GridQuantity<U extends string = string> {
  unit: U;
  /** 坐标基准：像素栅格所在的参考平面与原点 */
  datum: CoordinateDatum;
}

export interface CoordinateDatum {
  /** 参考坐标系，例如 "sample-plane" / "detector-plane" / "calibration-frame" */
  frame: string;
  origin: [number, number];
  /** 像素间距（nm/px），未知时为 null 并附诊断而不是丢弃 */
  pixelPitchNm: number | null;
}

export interface ConversionDiagnostic {
  code: string;
  message: string;
  /** 无法转换的值在原网格中的位置（行,列） */
  at?: [number, number];
}

const LENGTH_TO_NM: Record<LengthUnit, number> = { nm: 1, um: 1e3, mm: 1e6 };

export function lengthToNm(q: Quantity<LengthUnit>): number {
  return q.value * LENGTH_TO_NM[q.unit];
}

export function angleToRad(q: Quantity<AngleUnit>): number {
  return q.unit === "deg" ? (q.value * Math.PI) / 180 : q.value;
}
