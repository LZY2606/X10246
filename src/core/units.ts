/**
 * 单位与坐标基准：导入层保留原始表示；只有这里做规范化。
 * 无法转换的值不被丢弃，返回 {value:null, diagnostic} 留在原位置。
 */
import type { ConversionDiagnostic, UnitScalar } from "../shared/types.js";

const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  mm: 1e-3,
  um: 1e-6,
  µm: 1e-6,
  nm: 1e-9,
  pm: 1e-12,
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  deg: Math.PI / 180,
  mrad: 1e-3,
};

export interface ConversionResult {
  value: number | null;
  diagnostic?: ConversionDiagnostic;
}

export function toMeters(scalar: UnitScalar, path: string): ConversionResult {
  if (typeof scalar.raw === "string" || Number.isNaN(scalar.raw)) {
    return {
      value: null,
      diagnostic: diag("unconvertible", path, `原始值 ${String(scalar.raw)} 无法转成数值`, scalar.raw),
    };
  }
  const factor = LENGTH_TO_M[scalar.unit];
  if (factor === undefined) {
    return {
      value: null,
      diagnostic: diag("unknown_unit", path, `未知长度单位: ${scalar.unit}`, scalar),
    };
  }
  return { value: scalar.raw * factor };
}

export function toRadians(scalar: UnitScalar, path: string): ConversionResult {
  if (typeof scalar.raw === "string" || Number.isNaN(scalar.raw)) {
    return {
      value: null,
      diagnostic: diag("unconvertible", path, `原始角度 ${String(scalar.raw)} 无法转成数值`, scalar.raw),
    };
  }
  const factor = ANGLE_TO_RAD[scalar.unit];
  if (factor === undefined) {
    return {
      value: null,
      diagnostic: diag("unknown_unit", path, `未知角度单位: ${scalar.unit}`, scalar),
    };
  }
  return { value: scalar.raw * factor };
}

function diag(
  code: ConversionDiagnostic["code"],
  path: string,
  message: string,
  raw: unknown,
): ConversionDiagnostic {
  return { code, path, message, raw };
}

export function knownLengthUnits(): string[] {
  return Object.keys(LENGTH_TO_M);
}
