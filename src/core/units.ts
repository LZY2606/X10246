import type { Diagnostic, Quantity } from './types.js';

/** Multipliers to a canonical base (metres, radians, dimensionless 1). */
const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  mm: 1e-3,
  um: 1e-6,
  'µm': 1e-6,
  nm: 1e-9
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  mrad: 1e-3,
  deg: Math.PI / 180,
  '°': Math.PI / 180
};

const DIMENSIONLESS = new Set(['1', '', 'count', 'fraction', 'cycles']);

export type Dimension = 'length' | 'angle' | 'dimensionless';

export function dimensionOf(unit: string): Dimension | null {
  if (unit in LENGTH_TO_M) return 'length';
  if (unit in ANGLE_TO_RAD) return 'angle';
  if (DIMENSIONLESS.has(unit)) return 'dimensionless';
  return null;
}

export interface NormalizedQuantity {
  value: number;
  unit: string;
  basis: string;
  convertedFrom: string;
}

/**
 * Normalize for the derived layer only. When the unit cannot be converted the
 * ORIGINAL value is returned at its source position together with a diagnostic
 * rather than being silently dropped or guessed.
 */
export function normalizeQuantity(
  quantity: Quantity,
  location: string
): { value: NormalizedQuantity | null; diagnostic: Diagnostic | null } {
  const dim = dimensionOf(quantity.unit);
  if (dim === 'length') {
    return {
      value: {
        value: quantity.value * LENGTH_TO_M[quantity.unit]!,
        unit: 'm',
        basis: quantity.basis,
        convertedFrom: quantity.unit
      },
      diagnostic: null
    };
  }
  if (dim === 'angle') {
    return {
      value: {
        value: quantity.value * ANGLE_TO_RAD[quantity.unit]!,
        unit: 'rad',
        basis: quantity.basis,
        convertedFrom: quantity.unit
      },
      diagnostic: null
    };
  }
  if (dim === 'dimensionless') {
    return {
      value: {
        value: quantity.value,
        unit: quantity.unit || '1',
        basis: quantity.basis,
        convertedFrom: quantity.unit
      },
      diagnostic: null
    };
  }
  return {
    value: null,
    diagnostic: {
      code: 'UNCONVERTIBLE_UNIT',
      message: `Cannot normalize quantity with unit ${JSON.stringify(quantity.unit)}; original value retained at source`,
      locations: [location]
    }
  };
}

export function wrapAngleRad(phi: number): number {
  let wrapped = phi % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  if (wrapped <= -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}
