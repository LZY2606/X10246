/**
 * 单位与坐标基准：导入层保留原始表示，只有派生层才做规范化。
 * 无法转换的值返回 null + 诊断，绝不静默丢弃。
 */

const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  mm: 1_000_000,
  m: 1_000_000_000
};

export function convertLengthToNm(raw: number, units: string): { value: number | null; diagnostic: string | null } {
  const factor = LENGTH_TO_NM[units];
  if (factor === undefined) {
    return { value: null, diagnostic: `unconvertible-length-unit:${units}` };
  }
  return { value: raw * factor, diagnostic: null };
}

export function nmToUm(nm: number): number {
  return nm / 1000;
}

export function angleToRad(raw: number, units: string): { value: number | null; diagnostic: string | null } {
  if (units === 'rad') return { value: raw, diagnostic: null };
  if (units === 'deg') return { value: (raw * Math.PI) / 180, diagnostic: null };
  return { value: null, diagnostic: `unconvertible-angle-unit:${units}` };
}

export const TWO_PI = Math.PI * 2;

/** 规范化到 (-pi, pi]，保留原原始值在 RawCell.raw 中 */
export function wrapPi(phi: number): number {
  let w = phi % TWO_PI;
  if (w <= -Math.PI) w += TWO_PI;
  if (w > Math.PI) w -= TWO_PI;
  return w;
}

export function nearestInteger(x: number): number {
  return Math.round(x);
}
