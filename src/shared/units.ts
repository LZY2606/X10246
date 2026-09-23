import type { Diagnostic, Qty, Unit } from './types';

const LENGTH_TO_MM: Record<string, number> = { nm: 1e-6, mm: 1 };

export interface Normalized {
  ok: boolean;
  value?: number; // 目标单位下的值
  diagnostic?: Diagnostic;
}

/**
 * 派生层的单位规范化。原始表示在导入层原样保留；
 * 无法转换的值留在原位置并附诊断，绝不为了画图丢掉。
 */
export function normalize(qty: Qty, target: Unit): Normalized {
  if (qty.unit === target) return { ok: true, value: qty.value };
  if (target === 'mm' && qty.unit in LENGTH_TO_MM) {
    return { ok: true, value: qty.value * LENGTH_TO_MM[qty.unit] };
  }
  if (target === 'rad' && qty.unit === 'deg') {
    return { ok: true, value: (qty.value * Math.PI) / 180 };
  }
  return {
    ok: false,
    diagnostic: {
      code: 'unit.unconvertible',
      message: `无法把 ${qty.value} ${qty.unit} 规范化为 ${target}，原值保留在原位置`,
      raw: qty,
    },
  };
}
