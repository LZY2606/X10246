/**
 * 领域单位与坐标基准。
 * 所有领域量都携带单位或坐标基准；导入时保留原始表示，派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。
 */
export type LengthUnit = 'nm' | 'um' | 'mm' | 'm' | 'px';
export type AngleUnit = 'rad' | 'deg' | 'cycle';

/** 坐标基准：像素格网索引 / 物理标定坐标 / 传感器坐标 */
export type CoordinateFrame =
  | { kind: 'pixel'; origin: 'top-left'; indexing: '0-based' }
  | { kind: 'calibrated'; basis: 'calibration-surface-id'; unit: LengthUnit }
  | { kind: 'sensor'; unit: LengthUnit };

export const FRAME_PIXEL: CoordinateFrame = { kind: 'pixel', origin: 'top-left', indexing: '0-based' };

/** 长度单位 -> 米，px 必须借助标定面才能换算（缺标定时不可转换） */
const LENGTH_TO_M: Record<Exclude<LengthUnit, 'px'>, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1,
};

export function angleToRad(value: number, unit: AngleUnit): number {
  switch (unit) {
    case 'rad':
      return value;
    case 'deg':
      return (value * Math.PI) / 180;
    case 'cycle':
      return value * 2 * Math.PI;
  }
}

/**
 * 把长度规范化为米。像素单位没有标定面时不可转换：返回诊断而不是猜测。
 */
export function lengthToMeters(
  value: number,
  unit: LengthUnit,
  pixelScaleMeters?: number,
): { ok: true; meters: number } | { ok: false; diagnostic: UnitDiagnostic } {
  if (unit === 'px') {
    if (pixelScaleMeters === undefined || !Number.isFinite(pixelScaleMeters)) {
      return {
        ok: false,
        diagnostic: {
          code: 'UNCONVERTIBLE_PIXEL_WITHOUT_CALIBRATION',
          message: '像素长度缺少有效标定面，保留原值，未做物理换算',
          originalValue: value,
          originalUnit: unit,
        },
      };
    }
    return { ok: true, meters: value * pixelScaleMeters };
  }
  return { ok: true, meters: value * LENGTH_TO_M[unit] };
}

export interface UnitDiagnostic {
  code: 'UNCONVERTIBLE_PIXEL_WITHOUT_CALIBRATION' | 'UNKNOWN_UNIT' | 'NON_FINITE';
  message: string;
  originalValue?: number;
  originalUnit?: string;
}
