import type { Quant } from './types.js';

/**
 * 单位换算表（到 SI）。导入时保留原始表示；派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。
 */
const TO_SI: Record<string, { factor: number; siUnit: string }> = {
  radian: { factor: 1, siUnit: 'radian' },
  degree: { factor: Math.PI / 180, siUnit: 'radian' },
  nanometer: { factor: 1e-9, siUnit: 'meter' },
  micrometer: { factor: 1e-6, siUnit: 'meter' },
  millimeter: { factor: 1e-3, siUnit: 'meter' },
  meter: { factor: 1, siUnit: 'meter' },
  dimensionless: { factor: 1, siUnit: 'dimensionless' },
  count: { factor: 1, siUnit: 'count' },
  cycle: { factor: 1, siUnit: 'cycle' },
  arbitrary: { factor: 1, siUnit: 'arbitrary' },
};

export function toSi(q: Quant): { siValue?: number; diagnostic?: string } {
  const conv = TO_SI[q.unit];
  if (!conv) {
    return { diagnostic: `未知单位「${q.unit}」，值 ${q.value} 保留在原位置未做规范化` };
  }
  if (!Number.isFinite(q.value)) {
    return { diagnostic: `无法转换的非有限值（${String(q.value)}），保留原始表示` };
  }
  return { siValue: q.value * conv.factor };
}

export function normalizeQuant(q: Quant): Quant {
  const { siValue, diagnostic } = toSi(q);
  return { ...q, siValue, conversionDiagnostic: diagnostic };
}

export function wrapToPrincipal(phi: number): number {
  let w = phi % (2 * Math.PI);
  if (w > Math.PI) w -= 2 * Math.PI;
  if (w <= -Math.PI) w += 2 * Math.PI;
  return w;
}

export const TWO_PI = 2 * Math.PI;
