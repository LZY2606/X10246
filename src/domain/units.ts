/**
 * 领域词汇：物理量、单位与坐标基准。
 *
 * 规则（不可为画图丢信息）：
 *  - 导入时保留原始表示 raw：数值 + 原始单位 + 原始坐标基准；
 *  - 派生层才做规范化（normalizeQuantity）；
 *  - 无法转换的值不转换，保留原位置并由诊断（diagnostics）说明；
 *  - 所有领域量都携带单位或坐标基准。
 */

export type UnitName =
  | 'radian'        // 相位（包裹 [-pi, pi) 或展开值）
  | 'turn'          // 整周 = 2*pi
  | 'degree'        // 角度
  | 'nanometer'
  | 'micrometer'
  | 'millimeter'
  | 'meter'
  | 'pixel'         // 传感器像素坐标
  | 'count'         // 无量纲计数（振幅/灰度）
  | 'dimensionless'
  | 'decibel';

export type CoordinateBasis =
  | 'pixel-grid'          // 行列像素坐标，原点在左上角，r 向下、c 向右
  | 'calibration-plane'   // 标定面上的物理坐标
  | 'object-surface';     // 物面坐标

export interface TypedValue {
  /** 原始数值，保留导入时的表示（不预先换算）。 */
  raw: number;
  /** 原始单位。 */
  unit: UnitName;
  /** 规范化后的数值；无法转换时为 null。 */
  normalized: number | null;
  /** 规范化目标单位（由领域固定，不由用户随意指定）。 */
  normalizedUnit: UnitName;
  /** 坐标基准（空间量必填，纯标量为 null）。 */
  basis: CoordinateBasis | null;
  /** 无法规范化时的诊断代码；可转换为 null。 */
  diagnostic: string | null;
}

/** 单位换算表：以 SI/领域标准单位为目标。长度统一到 meter，角度统一到 radian。 */
const TO_NORMAL: Record<UnitName, { unit: UnitName; factor: number } | null> = {
  radian: { unit: 'radian', factor: 1 },
  turn: { unit: 'radian', factor: 2 * Math.PI },
  degree: { unit: 'radian', factor: Math.PI / 180 },
  nanometer: { unit: 'meter', factor: 1e-9 },
  micrometer: { unit: 'meter', factor: 1e-6 },
  millimeter: { unit: 'meter', factor: 1e-3 },
  meter: { unit: 'meter', factor: 1 },
  pixel: { unit: 'pixel', factor: 1 }, // 像素不做物理换算，需像素节距（在几何里）
  count: { unit: 'count', factor: 1 },
  dimensionless: { unit: 'dimensionless', factor: 1 },
  decibel: { unit: 'decibel', factor: 1 },
};

export interface QuantityInput {
  raw: number;
  unit: UnitName;
  basis?: CoordinateBasis | null;
}

export function makeValue(q: QuantityInput): TypedValue {
  const conv = TO_NORMAL[q.unit];
  const basis = q.basis ?? null;
  if (!conv) {
    return {
      raw: q.raw,
      unit: q.unit,
      normalized: null,
      normalizedUnit: q.unit,
      basis,
      diagnostic: `UNKNOWN_UNIT:${q.unit}`,
    };
  }
  if (Number.isNaN(q.raw) || !Number.isFinite(q.raw)) {
    return {
      raw: q.raw,
      unit: q.unit,
      normalized: null,
      normalizedUnit: conv.unit,
      basis,
      diagnostic: `NON_FINITE_VALUE:${String(q.raw)}`,
    };
  }
  return {
    raw: q.raw,
    unit: q.unit,
    normalized: q.raw * conv.factor,
    normalizedUnit: conv.unit,
    basis,
    diagnostic: null,
  };
}

/** 长度便捷规范化到 meter。 */
export function lengthMeters(q: QuantityInput): TypedValue {
  return makeValue(q);
}

/** 角度便捷规范化到 radian。 */
export function angleRadians(q: QuantityInput): TypedValue {
  return makeValue(q);
}

/** 像素节距（每像素物理长度），把 pixel 量映射到物理长度；失败保留原值。 */
export function convertPixelToMeters(pixels: TypedValue, pixelPitchMeters: TypedValue): TypedValue {
  if (pixels.unit !== 'pixel' || pixels.normalized === null) {
    return { ...pixels, diagnostic: pixels.diagnostic ?? 'NOT_A_PIXEL_QUANTITY' };
  }
  if (pixelPitchMeters.normalizedUnit !== 'meter' || pixelPitchMeters.normalized === null) {
    return { ...pixels, diagnostic: 'MISSING_PIXEL_PITCH' };
  }
  return {
    raw: pixels.raw,
    unit: 'pixel',
    normalized: pixels.raw * pixelPitchMeters.normalized,
    normalizedUnit: 'meter',
    basis: pixels.basis,
    diagnostic: null,
  };
}

export const TWO_PI = 2 * Math.PI;

/** 包裹到主值区间 [-pi, pi)。 */
export function wrapToPi(phi: number): number {
  let w = phi % TWO_PI;
  if (w >= Math.PI) w -= TWO_PI;
  if (w < -Math.PI) w += TWO_PI;
  return w;
}
