import type { Diagnostic, GridCoord, UnitQuantity } from "./types.ts";

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  "μm": 1000,
  mm: 1_000_000,
  m: 1_000_000_000
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  deg: Math.PI / 180,
  "°": Math.PI / 180
};

function diag(code: string, message: string, coordinate?: GridCoord): Diagnostic {
  return { code, severity: "error", message, coordinate };
}

/** 通用 "<数值> <单位>" 解析；保留 raw，转换失败时 value/canonicalValue 为 null。 */
export function parseQuantity(
  raw: string,
  table: Record<string, number>,
  canonicalUnit: string,
  coordinate?: GridCoord
): UnitQuantity {
  const trimmed = raw.trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]+)?$/.exec(trimmed);
  if (!m) {
    return {
      raw,
      value: null,
      unit: null,
      canonicalValue: null,
      canonicalUnit,
      diagnostics: [diag("UNIT_UNPARSEABLE", `无法解析的量: "${raw}"`, coordinate)]
    };
  }
  const value = Number(m[1]);
  const unit = (m[2] ?? "").trim();
  const factor = table[unit];
  if (factor === undefined) {
    return {
      raw,
      value,
      unit,
      canonicalValue: null,
      canonicalUnit,
      diagnostics: [diag("UNIT_UNKNOWN", `未知或不可转换单位: "${unit}"（原始值保留原位）`, coordinate)]
    };
  }
  return { raw, value, unit, canonicalValue: value * factor, canonicalUnit, diagnostics: [] };
}

export function parseWavelength(raw: string, coordinate?: GridCoord): UnitQuantity {
  return parseQuantity(raw, LENGTH_TO_NM, "nm", coordinate);
}

export function parseAngle(raw: string, coordinate?: GridCoord): UnitQuantity {
  return parseQuantity(raw, ANGLE_TO_RAD, "rad", coordinate);
}

/** 节距形如 "0.005 mm/pix"，归一化到 nm/pix。 */
export function parsePixelPitch(raw: string, coordinate?: GridCoord): UnitQuantity {
  const trimmed = raw.trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s/]+)\/pix$/.exec(trimmed);
  if (!m) {
    return {
      raw,
      value: null,
      unit: null,
      canonicalValue: null,
      canonicalUnit: "nm/pix",
      diagnostics: [diag("PITCH_UNPARSEABLE", `无法解析的像素节距: "${raw}"（应为如 0.005 mm/pix）`, coordinate)]
    };
  }
  const value = Number(m[1]);
  const unit = m[2];
  const factor = LENGTH_TO_NM[unit];
  if (factor === undefined) {
    return {
      raw,
      value,
      unit: `${unit}/pix`,
      canonicalValue: null,
      canonicalUnit: "nm/pix",
      diagnostics: [diag("UNIT_UNKNOWN", `节距单位不可转换: "${unit}/pix"（原始值保留原位）`, coordinate)]
    };
  }
  return {
    raw,
    value,
    unit: `${unit}/pix`,
    canonicalValue: value * factor,
    canonicalUnit: "nm/pix",
    diagnostics: []
  };
}

/** 高度换算灵敏度因子：λ / (2π(cos θ_i + cos θ_o))，单位 nm/rad。 */
export function sensitivityNmPerRad(wavelength: UnitQuantity, incidence: UnitQuantity, observation: UnitQuantity): number | null {
  if (
    wavelength.canonicalValue === null ||
    incidence.canonicalValue === null ||
    observation.canonicalValue === null
  ) {
    return null;
  }
  const denom = 2 * Math.PI * (Math.cos(incidence.canonicalValue) + Math.cos(observation.canonicalValue));
  if (denom <= 0) return null;
  return wavelength.canonicalValue / denom;
}

export function quantity(raw: string, value: number | null, unit: string | null): UnitQuantity {
  return { raw, value, unit, canonicalValue: value, canonicalUnit: unit, diagnostics: [] };
}
