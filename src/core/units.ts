/**
 * 单位与坐标基准。
 * 原则：导入时保留原始表示（rawValue/rawUnit/rawFrame），派生层才规范化；
 * 无法转换的值留在原位置并附诊断，绝不为了画图丢掉。
 */

export type Unit =
  | 'rad' | 'deg' | 'count'
  | 'nm' | 'um' | 'mm' | 'm'
  | 'nm/px' | 'um/px'
  | '1';

export type CoordFrame =
  | 'sensor-pixel'      // 传感器像素坐标 (row, col)
  | 'sample-physical';  // 样品物理坐标 (x, y)，需要 pixelPitch 才能换算

export interface Quantity {
  value: number;
  unit: Unit;
  frame?: CoordFrame;
}

export interface ConversionOk { ok: true; value: number; }
export interface ConversionFail { ok: false; diagnostic: Diagnostic; }
export type Conversion = ConversionOk | ConversionFail;

export interface Diagnostic {
  code: string;
  message: string;
  at?: { row?: number; col?: number; ref?: string };
}

const LENGTH_TO_NM: Record<string, number> = { nm: 1, um: 1e3, mm: 1e6, m: 1e9 };

export function convertQuantity(q: Quantity, toUnit: Unit): Conversion {
  if (q.unit === toUnit) return { ok: true, value: q.value };
  if (q.unit === 'rad' && toUnit === 'deg') return { ok: true, value: q.value * 180 / Math.PI };
  if (q.unit === 'deg' && toUnit === 'rad') return { ok: true, value: q.value * Math.PI / 180 };
  const fromLen = LENGTH_TO_NM[q.unit];
  const toLen = LENGTH_TO_NM[toUnit];
  if (fromLen !== undefined && toLen !== undefined) {
    return { ok: true, value: q.value * fromLen / toLen };
  }
  return {
    ok: false,
    diagnostic: {
      code: 'UNIT_UNCONVERTIBLE',
      message: `无法把 ${q.value} ${q.unit} 转换为 ${toUnit}；值保留原始表示，不进入派生层`
    }
  };
}

/** 像素坐标 → 物理坐标；缺少像素间距时返回诊断，原始像素坐标保留。 */
export function pixelToPhysical(
  row: number, col: number, pitch: Quantity | undefined
): { ok: true; x: number; y: number; unit: Unit } | { ok: false; diagnostic: Diagnostic } {
  if (!pitch) {
    return {
      ok: false,
      diagnostic: {
        code: 'FRAME_UNCONVERTIBLE',
        message: '缺少 pixelPitch，sensor-pixel 无法换算到 sample-physical；保留像素坐标',
        at: { row, col }
      }
    };
  }
  const c = convertQuantity(pitch, 'um');
  if (!c.ok) return { ok: false, diagnostic: c.diagnostic };
  return { ok: true, x: col * c.value, y: row * c.value, unit: 'um' };
}
