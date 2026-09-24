import type { Diagnostic } from './domain';

/**
 * 单位与坐标基准：导入层保留原始表示，派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，不能为了画图而丢掉。
 */

export interface NormalizedNumber {
  ok: boolean;
  valueUm?: number;       // 规范化到 μm
  diagnostic?: Diagnostic;
}

const LENGTH_TO_UM: Record<string, number> = {
  um: 1,
  nm: 0.001,
  mm: 1000,
};

export function normalizeLength(value: number, unit: string, where: string): NormalizedNumber {
  const factor = LENGTH_TO_UM[unit];
  if (factor === undefined) {
    return {
      ok: false,
      diagnostic: {
        code: 'unit_unconverted',
        message: `无法转换的单位 "${unit}"（${where}），原值 ${value} 保留在原位置`,
      },
    };
  }
  return { ok: true, valueUm: value * factor };
}

export interface NormalizedAngle {
  ok: boolean;
  valueRad?: number;
  diagnostic?: Diagnostic;
}

export function normalizeAngle(value: number, unit: string, where: string): NormalizedAngle {
  if (unit === 'rad') return { ok: true, valueRad: value };
  if (unit === 'deg') return { ok: true, valueRad: (value * Math.PI) / 180 };
  return {
    ok: false,
    diagnostic: {
      code: 'unit_unconverted',
      message: `无法转换的角度单位 "${unit}"（${where}），原值 ${value} 保留在原位置`,
    },
  };
}
