import type { Quantity, Unit } from './domain';

// 所有领域量携带单位/坐标基准。原始层保留原表示；派生层才规范化。
// 无法转换的值不丢弃：返回 diagnostic，值留在原位置。

const TO_CANONICAL: Partial<Record<Unit, { canonical: Unit; factor: number }>> = {
  rad: { canonical: 'rad', factor: 1 },
  deg: { canonical: 'rad', factor: Math.PI / 180 },
  cycle: { canonical: 'rad', factor: 2 * Math.PI },
  nm: { canonical: 'nm', factor: 1 },
  um: { canonical: 'nm', factor: 1000 },
  mm: { canonical: 'nm', factor: 1_000_000 },
  m: { canonical: 'nm', factor: 1_000_000_000 },
  px: { canonical: 'px', factor: 1 },
  ratio: { canonical: 'ratio', factor: 1 },
  count: { canonical: 'count', factor: 1 },
};

export interface NormalizedQuantity {
  value: number;
  unit: Unit;
  frame?: string;
}
export interface UnitDiagnostic {
  path: string;
  code: 'UNKNOWN_UNIT' | 'INCOMPATIBLE_DIMENSION';
  message: string;
  raw: Quantity;
}
export type NormalizeResult =
  | { ok: true; value: NormalizedQuantity }
  | { ok: false; diagnostic: UnitDiagnostic };

export function normalizeQuantity(q: Quantity, path = '$'): NormalizeResult {
  if (typeof q?.value !== 'number' || typeof q?.unit !== 'string') {
    return {
      ok: false,
      diagnostic: { path, code: 'UNKNOWN_UNIT', message: `缺少单位或值: ${JSON.stringify(q)}`, raw: q },
    };
  }
  const rule = TO_CANONICAL[q.unit];
  if (!rule) {
    return {
      ok: false,
      diagnostic: {
        path,
        code: 'UNKNOWN_UNIT',
        message: `未知单位 ${q.unit}，无法转换，保留原始表示`,
        raw: q,
      },
    };
  }
  return { ok: true, value: { value: q.value * rule.factor, unit: rule.canonical, frame: q.frame } };
}

export function requireSameDimension(a: Unit, b: Unit): boolean {
  const lengthUnits: Unit[] = ['nm', 'um', 'mm', 'm'];
  const angleUnits: Unit[] = ['rad', 'deg', 'cycle'];
  if (lengthUnits.includes(a) && lengthUnits.includes(b)) return true;
  if (angleUnits.includes(a) && angleUnits.includes(b)) return true;
  return a === b;
}
