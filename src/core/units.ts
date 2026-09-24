import type { AngleUnit, LengthUnit, Diagnosis, UnitValue } from './types.js';

const LENGTH_TO_M: Record<LengthUnit, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1,
};

const ANGLE_TO_RAD: Record<AngleUnit, number> = { rad: 1, deg: Math.PI / 180 };

/** 长度单位换算到米；无法转换时返回诊断（保留原值在原位置） */
export function lengthToMeters(v: UnitValue<number>): { value?: number; diagnosis?: Diagnosis } {
  const f = LENGTH_TO_M[v.unit as LengthUnit];
  if (f === undefined) {
    return {
      diagnosis: {
        code: 'units/unconvertible-length',
        severity: 'error',
        message: `无法把长度单位 ${v.unit} 转换为米，值保留在原位置`,
        rawValue: v.value,
        rawUnit: v.unit,
      },
    };
  }
  return { value: v.value * f };
}

export function metersTo(valueM: number, unit: LengthUnit): number {
  return valueM / LENGTH_TO_M[unit];
}

/** 角度换算到弧度 */
export function angleToRad(value: number, unit: AngleUnit): number {
  return value * ANGLE_TO_RAD[unit];
}

/** 把任意角度 wrap 到 (-pi, pi] */
export function wrapPi(a: number): number {
  let x = ((a + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** 内容摘要（短，用于查询返回） */
export function summarize(value: unknown, max = 80): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
