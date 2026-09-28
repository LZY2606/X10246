/** 单位注册表：所有领域量携带单位或坐标基准；无法转换的值留在原位置并附诊断。 */

export type LengthUnit = "nm" | "um" | "mm" | "m";
export type AngleUnit = "rad" | "deg" | "fringe";
export type RatioUnit = "ratio";
export type Unit = LengthUnit | AngleUnit | RatioUnit;

export const LENGTH_TO_NM: Record<LengthUnit, number> = {
  nm: 1,
  um: 1e3,
  mm: 1e6,
  m: 1e9,
};

export function isLengthUnit(u: string): u is LengthUnit {
  return u in LENGTH_TO_NM;
}

export function isAngleUnit(u: string): u is AngleUnit {
  return u === "rad" || u === "deg" || u === "fringe";
}

export function toRadians(value: number, unit: AngleUnit): number {
  if (unit === "rad") return value;
  if (unit === "deg") return (value * Math.PI) / 180;
  return value * 2 * Math.PI; // fringe
}

export function fromRadians(value: number, unit: AngleUnit): number {
  if (unit === "rad") return value;
  if (unit === "deg") return (value * 180) / Math.PI;
  return value / (2 * Math.PI);
}

export function toNm(value: number, unit: LengthUnit): number {
  return value * LENGTH_TO_NM[unit];
}

export function fromNm(value: number, unit: LengthUnit): number {
  return value / LENGTH_TO_NM[unit];
}

export interface UnitConversionResult {
  ok: boolean;
  value?: number;
  unit?: Unit;
  diagnostic?: string;
}

export function convertValue(
  value: number,
  from: string,
  to: string,
): UnitConversionResult {
  if (from === to) return { ok: true, value, unit: to as Unit };
  if (isLengthUnit(from) && isLengthUnit(to)) {
    return { ok: true, value: fromNm(toNm(value, from), to), unit: to };
  }
  if (isAngleUnit(from) && isAngleUnit(to)) {
    return { ok: true, value: fromRadians(toRadians(value, from), to), unit: to };
  }
  return {
    ok: false,
    diagnostic: `UNIT_INCONVERTIBLE: 无法将 "${from}" 转换为 "${to}"，值保留原始表示`,
  };
}

/** 坐标基准：像素坐标系（行主序，y 向下）与样品物理坐标系。 */
export type CoordinateBasis = "pixel-ij" | "sample-xy";

export interface PixelGrid {
  width: number;
  height: number;
  basis: CoordinateBasis;
}
