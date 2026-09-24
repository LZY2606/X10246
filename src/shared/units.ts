import type { Dimensioned } from "./domain.ts";

/** 已知单位换算表（离线，无外部依赖）。无法转换的值留在原位置并附诊断。 */
const TO_SI: Record<string, { base: string; factor: number }> = {
  nm: { base: "m", factor: 1e-9 },
  um: { base: "m", factor: 1e-6 },
  mm: { base: "m", factor: 1e-3 },
  m: { base: "m", factor: 1 },
  rad: { base: "rad", factor: 1 },
  deg: { base: "rad", factor: Math.PI / 180 },
  "°": { base: "rad", factor: Math.PI / 180 }
};

export function normalizeDimensioned(d: Dimensioned): Dimensioned {
  const rule = TO_SI[d.unit];
  if (!rule) {
    return {
      ...d,
      normalized: { value: NaN, unit: "?", convertible: false, reason: `未知单位 ${d.unit}` },
      diagnostic: `无法把 ${d.unit} 规范化：保留原始表示，画图不得丢弃`
    };
  }
  return {
    ...d,
    normalized: { value: d.value * rule.factor, unit: rule.base, convertible: true }
  };
}

export function toUnit(d: Dimensioned, target: string): { value: number; ok: boolean; reason?: string } {
  const n = normalizeDimensioned(d);
  if (!n.normalized?.convertible) return { value: NaN, ok: false, reason: n.diagnostic };
  const t = TO_SI[target];
  if (!t || t.base !== n.normalized.unit)
    return { value: NaN, ok: false, reason: `${d.unit} 与 ${target} 量纲不一致` };
  return { value: n.normalized.value / t.factor, ok: true };
}

export function assertUnit(unit: unknown, path: string): asserts unit is string {
  if (typeof unit !== "string" || unit.trim() === "") {
    const e = new Error(`[format:unit-missing] 缺少单位 @ ${path}`);
    e.name = "FormatError";
    throw e;
  }
}
