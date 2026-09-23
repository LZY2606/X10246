import type { Diagnostic, Quantity, Unit } from './types.ts';

const LENGTH_TO_NM: Partial<Record<Unit, number>> = {
  nm: 1,
  um: 1000,
  angstrom: 0.1,
};

export type Conversion =
  | { ok: true; value: number }
  | { ok: false; diagnostic: Diagnostic };

/** 派生层才做规范化；无法转换时保留原值并附诊断 */
export function toNm(q: Quantity<number>, at: string): Conversion {
  const factor = LENGTH_TO_NM[q.unit];
  if (factor === undefined) {
    return {
      ok: false,
      diagnostic: {
        code: 'unit.unconvertible',
        message: `无法把单位 '${q.unit}' 转换为 nm；原值保留在原位置`,
        at,
      },
    };
  }
  return { ok: true, value: q.value * factor };
}

export function toRad(q: Quantity<number>, at: string): Conversion {
  if (q.unit === 'rad') return { ok: true, value: q.value };
  if (q.unit === 'deg') return { ok: true, value: (q.value * Math.PI) / 180 };
  return {
    ok: false,
    diagnostic: {
      code: 'unit.unconvertible',
      message: `无法把单位 '${q.unit}' 转换为 rad；原值保留在原位置`,
      at,
    },
  };
}
