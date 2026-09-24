/**
 * 领域量：导入层保留原始表示（raw），派生层才做规范化（si / canonical）。
 * 无法转换的值留在原位置并附诊断，绝不为了画图而丢弃。
 */

export type PhysicalKind =
  | 'angle' // wrapped phase 弧度或度
  | 'length' // 波长、坐标、高度
  | 'dimensionless' // SNR、振幅、归一化评分
  | 'cycles'; // 整周偏移

export const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  radian: 1,
  radians: 1,
  deg: Math.PI / 180,
  degree: Math.PI / 180,
  degrees: Math.PI / 180,
};

export const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  meter: 1,
  meters: 1,
  mm: 1e-3,
  um: 1e-6,
  'µm': 1e-6,
  micron: 1e-6,
  nm: 1e-9,
};

export interface Quantity {
  /** 原始表示（导入时原样保留） */
  raw: number | string;
  /** 原始单位 */
  unit: string;
  /** 物理量类别 */
  kind: PhysicalKind;
  /** 规范化数值（无法转换时为 null，诊断写入 diagnostics） */
  si: number | null;
  /** 规范化单位说明 */
  siUnit: string;
}

export interface QuantityFailure {
  code: string;
  message: string;
}

export function makeQuantity(
  raw: number | string,
  unit: string,
  kind: PhysicalKind,
): { q: Quantity; failure: QuantityFailure | null } {
  const numeric = typeof raw === 'number' && Number.isFinite(raw) ? raw : Number(raw);
  if (!Number.isFinite(numeric)) {
    return {
      q: { raw, unit, kind, si: null, siUnit: siUnitOf(kind) },
      failure: {
        code: 'Q_NOT_NUMERIC',
        message: `无法把 ${JSON.stringify(raw)} 解析为数值，保留原值于原位`,
      },
    };
  }
  const norm = normalize(numeric, unit, kind);
  if (norm === null) {
    return {
      q: { raw, unit, kind, si: null, siUnit: siUnitOf(kind) },
      failure: {
        code: 'Q_UNKNOWN_UNIT',
        message: `未知单位 ${JSON.stringify(unit)}（物理类别 ${kind}），无法转换，保留原值于原位`,
      },
    };
  }
  return { q: { raw, unit, kind, si: norm, siUnit: siUnitOf(kind) }, failure: null };
}

export function siUnitOf(kind: PhysicalKind): string {
  switch (kind) {
    case 'angle':
      return 'rad';
    case 'length':
      return 'm';
    case 'cycles':
      return 'cycle';
    case 'dimensionless':
      return '';
  }
}

function normalize(value: number, unit: string, kind: PhysicalKind): number | null {
  const u = unit.trim();
  switch (kind) {
    case 'dimensionless':
      return u === '' || u === '1' || u.toLowerCase() === 'snr' ? value : null;
    case 'cycles':
      return u === 'cycle' || u === 'cycles' || u === 'fringe' || u === '' ? value : null;
    case 'angle': {
      const f = ANGLE_TO_RAD[u.toLowerCase()];
      return f === undefined ? null : value * f;
    }
    case 'length': {
      const f = LENGTH_TO_M[u.toLowerCase()];
      return f === undefined ? null : value * f;
    }
  }
}

/** 包裹相位（已规范化为弧度），保证在 (-pi, pi] */
export function wrapPi(rad: number): number {
  let r = ((rad + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
}
