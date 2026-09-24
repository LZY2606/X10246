/**
 * 领域量单位与坐标基准。
 * 导入层保留原始表示（raw + rawUnit + frame），派生层才规范化；
 * 无法转换的值留在原位置并附诊断，不为画图丢弃。
 */
export type QuantityKind = 'phase' | 'length' | 'angle' | 'ratio' | 'index';

export interface Quantity {
  value: number;
  unit: string;      // 原始单位，如 'rad' | 'nm' | 'um' | 'deg' | 'fringe'
  frame?: string;    // 坐标基准，如 'sensor-pixel' | 'optical-bench' | 'calibration-plane'
}

const LENGTH_TO_NM: Record<string, number> = { nm: 1, um: 1e3, mm: 1e6, m: 1e9 };
const ANGLE_TO_RAD: Record<string, number> = { rad: 1, deg: Math.PI / 180 };
const PHASE_TO_RAD: Record<string, number> = { rad: 1, fringe: 2 * Math.PI, cycles: 2 * Math.PI };

export interface Conversion {
  ok: boolean;
  value?: number;        // 规范化后的值
  canonicalUnit?: string;
  diagnostic?: string;   // 无法转换时的诊断，原值留在原位置
}

export function normalizeQuantity(q: Quantity, kind: QuantityKind): Conversion {
  const table =
    kind === 'length' ? LENGTH_TO_NM :
    kind === 'angle' ? ANGLE_TO_RAD :
    kind === 'phase' ? PHASE_TO_RAD : null;
  const canonicalUnit = kind === 'length' ? 'nm' : kind === 'angle' ? 'rad' : kind === 'phase' ? 'rad' : '';
  if (kind === 'ratio' || kind === 'index') return { ok: true, value: q.value, canonicalUnit: '1' };
  if (!table) return { ok: false, diagnostic: `unknown_quantity_kind:${kind}` };
  const factor = table[q.unit];
  if (factor === undefined) {
    return { ok: false, diagnostic: `unconvertible_unit:${q.unit}->${canonicalUnit}` };
  }
  return { ok: true, value: q.value * factor, canonicalUnit };
}
