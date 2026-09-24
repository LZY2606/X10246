/** 领域量携带单位与坐标基准；无法转换的值留在原位置并附诊断。 */
export type Unit = 'rad' | 'nm' | 'um' | 'mm' | 'deg' | 'count' | 'score';

export interface Quantity {
  value: number;
  unit: Unit;
  /** 坐标基准，例如 'sensor-pixel'、'sample-plane'。 */
  frame?: string;
}

export interface ConversionResult {
  quantity: Quantity | null;
  /** 无法转换时的诊断；值必须留在原位置。 */
  diagnostic: string | null;
}

const LENGTH_TO_NM: Record<string, number> = { nm: 1, um: 1e3, mm: 1e6 };

export function convertLength(q: Quantity, target: Unit): ConversionResult {
  const from = LENGTH_TO_NM[q.unit];
  const to = LENGTH_TO_NM[target];
  if (from === undefined || to === undefined) {
    return { quantity: null, diagnostic: `cannot-convert:${q.unit}->${target}` };
  }
  return { quantity: { value: (q.value * from) / to, unit: target, frame: q.frame }, diagnostic: null };
}

export function degToRad(q: Quantity): ConversionResult {
  if (q.unit !== 'deg' && q.unit !== 'rad') {
    return { quantity: null, diagnostic: `cannot-convert:${q.unit}->rad` };
  }
  const value = q.unit === 'deg' ? (q.value * Math.PI) / 180 : q.value;
  return { quantity: { value, unit: 'rad', frame: q.frame }, diagnostic: null };
}
