import type { Quantity, Unit } from './types.js';

// 到 SI 基准的线性换算：value_si = value * factor (+ offset 角度特殊处理)
const LENGTH_TO_M: Record<string, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1,
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  degree: Math.PI / 180,
  turn: 2 * Math.PI,
};

export function normalizeQuantity(raw: string | number, unit: Unit): Quantity {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) {
    return { raw, unit, value: null, diagnostic: `unparseable quantity "${String(raw)}" for unit ${unit}` };
  }
  if (unit in LENGTH_TO_M) {
    return { raw, unit, value: num * LENGTH_TO_M[unit]! };
  }
  if (unit in ANGLE_TO_RAD) {
    return { raw, unit, value: num * ANGLE_TO_RAD[unit]! };
  }
  if (unit === 'unitless' || unit === 'dimensionless' || unit === 'count') {
    return { raw, unit, value: num };
  }
  return { raw, unit, value: null, diagnostic: `unknown or unconvertible unit "${unit}"` };
}

export function asMeters(q: Quantity): number | null {
  if (q.value === null) return null;
  if (q.unit in LENGTH_TO_M) return q.value;
  return null;
}

export function asRadians(q: Quantity): number | null {
  if (q.value === null) return null;
  if (q.unit in ANGLE_TO_RAD) return q.value;
  return null;
}

export function wrapToPi(phi: number): number {
  let w = phi % (2 * Math.PI);
  if (w > Math.PI) w -= 2 * Math.PI;
  if (w <= -Math.PI) w += 2 * Math.PI;
  return w;
}

export const UNITS = { LENGTH_TO_M, ANGLE_TO_RAD };
