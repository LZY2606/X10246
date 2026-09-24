import type { Quantity, Unit } from './types';

/** 长度换算表（到 nm） */
const LENGTH_TO_NM: Partial<Record<Unit, number>> = {
  nm: 1, um: 1e3, mm: 1e6, m: 1e9,
};

export class UnitConversionError extends Error {
  constructor(public from: Unit, public to: Unit) {
    super(`无法转换单位: ${from} -> ${to}`);
  }
}

/** 可转换则返回新量；不可转换抛错，调用方保留原值并附诊断 */
export function convertQuantity<V extends number>(q: Quantity<V>, to: Unit): Quantity<V> {
  if (q.unit === to) return q;
  if (q.unit in LENGTH_TO_NM && to in LENGTH_TO_NM) {
    const factor = LENGTH_TO_NM[q.unit]! / LENGTH_TO_NM[to]!;
    return { ...q, value: (q.value * factor) as V, unit: to };
  }
  if (q.unit === 'rad' && to === 'cycle') return { ...q, value: (q.value / (2 * Math.PI)) as V, unit: to };
  if (q.unit === 'cycle' && to === 'rad') return { ...q, value: (q.value * 2 * Math.PI) as V, unit: to };
  throw new UnitConversionError(q.unit, to);
}

export function canConvert(from: Unit, to: Unit): boolean {
  if (from === to) return true;
  if (from in LENGTH_TO_NM && to in LENGTH_TO_NM) return true;
  return (from === 'rad' && to === 'cycle') || (from === 'cycle' && to === 'rad');
}
