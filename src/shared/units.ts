/**
 * 领域量都携带单位或坐标基准。
 * 导入层保留原始表示（rawUnit 原样存放）；派生层才做规范化。
 * 无法转换的值留在原位置并附诊断，绝不为了画图丢掉。
 */
export type Unit = 'rad' | 'nm' | 'um' | 'mm' | 'deg' | '1';

export interface Quantity {
  value: number;
  unit: string; // 允许出现未知单位字符串：保留原样，规范化时报诊断
}

export interface GridBasis {
  axes: 'row-major-xy';
  origin: { x: Quantity; y: Quantity };
  spacing: { x: Quantity; y: Quantity };
}

export interface ScalarGrid {
  width: number;
  height: number;
  unit: string;
  basis: GridBasis;
  /** 行优先，长度 = width*height。无效位置为 null，绝不填猜测值。 */
  values: (number | null)[];
}

export interface Diagnostic {
  code: string;
  message: string;
  where?: { x: number; y: number } | { entity: string };
  raw?: unknown;
}

const LENGTH_TO_UM: Record<string, number> = { nm: 1e-3, um: 1, mm: 1e3 };

/** 规范化长度到 um。未知单位返回 null 并附诊断，原值由调用方保留。 */
export function normalizeLengthToUm(
  q: Quantity,
  diagnostics: Diagnostic[],
  where?: Diagnostic['where'],
): number | null {
  const f = LENGTH_TO_UM[q.unit];
  if (f === undefined) {
    diagnostics.push({
      code: 'UNIT_UNCONVERTIBLE',
      message: `无法把长度单位 "${q.unit}" 规范化为 um，原值保留在输入层`,
      where,
      raw: q,
    });
    return null;
  }
  return q.value * f;
}

export function normalizeAngleToRad(
  q: Quantity,
  diagnostics: Diagnostic[],
  where?: Diagnostic['where'],
): number | null {
  if (q.unit === 'rad') return q.value;
  if (q.unit === 'deg') return (q.value * Math.PI) / 180;
  diagnostics.push({
    code: 'UNIT_UNCONVERTIBLE',
    message: `无法把角度单位 "${q.unit}" 规范化为 rad，原值保留在输入层`,
    where,
    raw: q,
  });
  return null;
}

export function makeBasis(spacingUm: number): GridBasis {
  return {
    axes: 'row-major-xy',
    origin: { x: { value: 0, unit: 'um' }, y: { value: 0, unit: 'um' } },
    spacing: { x: { value: spacingUm, unit: 'um' }, y: { value: spacingUm, unit: 'um' } },
  };
}
