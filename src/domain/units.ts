/**
 * 领域量单位与坐标基准。
 * 导入层保留原始表示（raw），派生层才规范化；无法转换的值留在原位置并附诊断。
 */

export type UnitKind = "angle" | "length" | "dimensionless" | "score";

export interface UnitDef {
  symbol: string;
  kind: UnitKind;
  /** 转换到该 kind 基准单位（rad / m / 1）的倍率。 */
  toBase: number;
}

export const UNITS: Record<string, UnitDef> = {
  rad: { symbol: "rad", kind: "angle", toBase: 1 },
  cycle: { symbol: "cycle", kind: "angle", toBase: 2 * Math.PI },
  deg: { symbol: "deg", kind: "angle", toBase: Math.PI / 180 },
  m: { symbol: "m", kind: "length", toBase: 1 },
  mm: { symbol: "mm", kind: "length", toBase: 1e-3 },
  um: { symbol: "um", kind: "length", toBase: 1e-6 },
  nm: { symbol: "nm", kind: "length", toBase: 1e-9 },
  fringe: { symbol: "fringe", kind: "dimensionless", toBase: 1 },
  "1": { symbol: "1", kind: "dimensionless", toBase: 1 },
  snr_db: { symbol: "snr_db", kind: "score", toBase: 1 },
};

export interface Quantity {
  value: number;
  unit: string;
  /** 坐标基准，例如 "sensor-pixel"、"lab-frame"、"surface-normal"。 */
  frame?: string;
}

export interface ConversionDiagnostic {
  code: "unknown-unit" | "kind-mismatch";
  message: string;
  raw: Quantity;
}

export type ConversionResult =
  | { ok: true; value: number; baseUnit: string }
  | { ok: false; diagnostic: ConversionDiagnostic };

const BASE_UNIT: Record<UnitKind, string> = {
  angle: "rad",
  length: "m",
  dimensionless: "1",
  score: "snr_db",
};

export function convertToBase(q: Quantity): ConversionResult {
  const def = UNITS[q.unit];
  if (!def) {
    return {
      ok: false,
      diagnostic: {
        code: "unknown-unit",
        message: `未知单位 '${q.unit}'，值保留在原位置，不参与派生计算`,
        raw: q,
      },
    };
  }
  return { ok: true, value: q.value * def.toBase, baseUnit: BASE_UNIT[def.kind] };
}

export function convert(q: Quantity, targetUnit: string): ConversionResult {
  const from = UNITS[q.unit];
  const to = UNITS[targetUnit];
  if (!from || !to) {
    return {
      ok: false,
      diagnostic: {
        code: "unknown-unit",
        message: `未知单位 '${!from ? q.unit : targetUnit}'，值保留在原位置`,
        raw: q,
      },
    };
  }
  if (from.kind !== to.kind) {
    return {
      ok: false,
      diagnostic: {
        code: "kind-mismatch",
        message: `单位类别不匹配：${q.unit}(${from.kind}) 不能转为 ${targetUnit}(${to.kind})`,
        raw: q,
      },
    };
  }
  return { ok: true, value: (q.value * from.toBase) / to.toBase, baseUnit: targetUnit };
}
