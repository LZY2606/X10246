import type { AngleUnit, LengthUnit, Quantity } from "./types";

const LENGTH_TO_M: Record<LengthUnit, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1,
};
const ANGLE_TO_RAD: Record<AngleUnit, number> = { rad: 1, turn: 2 * Math.PI };

export function normalizeLength(q: Quantity): Quantity {
  if (LENGTH_TO_M[q.unit as LengthUnit] === undefined) {
    return { ...q, conversionDiagnostic: `UNCONVERTIBLE_UNIT:${q.unit}` };
  }
  const f = LENGTH_TO_M[q.unit as LengthUnit];
  const value = Array.isArray(q.value) ? q.value.map((v) => v * f) : q.value * f;
  return { ...q, value, unit: "m" };
}

export function normalizeAngle(q: Quantity): Quantity {
  if (ANGLE_TO_RAD[q.unit as AngleUnit] === undefined) {
    return { ...q, conversionDiagnostic: `UNCONVERTIBLE_UNIT:${q.unit}` };
  }
  const f = ANGLE_TO_RAD[q.unit as AngleUnit];
  const value = Array.isArray(q.value) ? q.value.map((v) => v * f) : q.value * f;
  return { ...q, value, unit: "rad" };
}

export const TWO_PI = Math.PI * 2;

export function wrapToPi(rad: number): number {
  let w = rad % TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  if (w < -Math.PI) w += TWO_PI;
  return w;
}

/** 包裹差分 -> 需要的整周数 k，使 wrappedDelta + 2πk 落在 (-π,π] 主值差分支。 */
export function wrapCountForDelta(wrappedDelta: number): number {
  return -Math.round(wrappedDelta / TWO_PI);
}
