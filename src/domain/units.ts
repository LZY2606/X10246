/**
 * Unit handling. Raw imports keep their original representation untouched;
 * normalization happens only in the derived layer. Values that cannot be
 * converted stay in place and carry a diagnostic instead of being dropped.
 */
export interface Quantity {
  value: number;
  unit: string;
}

export interface CoordFrame {
  /** e.g. "detector-pixels", origin and axis directions are domain metadata, kept verbatim. */
  name: string;
  origin?: string;
  axes?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  subject?: string;
  detail?: unknown;
}

export interface Normalized {
  ok: boolean;
  /** canonical value (meters for length, radians for angle/phase) when ok */
  canonical?: number;
  canonicalUnit?: string;
  diagnostic?: Diagnostic;
}

const LENGTH: Record<string, number> = { m: 1, mm: 1e-3, um: 1e-6, nm: 1e-9, pm: 1e-12 };
const ANGLE: Record<string, number> = { rad: 1, deg: Math.PI / 180, mrad: 1e-3 };
const PHASE: Record<string, number> = { rad: 1, fringe: Math.PI * 2, cycles: Math.PI * 2, deg: Math.PI / 180 };

export function normalizeLength(q: Quantity): Normalized {
  const f = LENGTH[q.unit];
  if (f === undefined) return unconvertible(q, 'm');
  return { ok: true, canonical: q.value * f, canonicalUnit: 'm' };
}

export function normalizeAngle(q: Quantity): Normalized {
  const f = ANGLE[q.unit];
  if (f === undefined) return unconvertible(q, 'rad');
  return { ok: true, canonical: q.value * f, canonicalUnit: 'rad' };
}

export function normalizePhase(q: Quantity): Normalized {
  const f = PHASE[q.unit];
  if (f === undefined) return unconvertible(q, 'rad');
  return { ok: true, canonical: q.value * f, canonicalUnit: 'rad' };
}

function unconvertible(q: Quantity, wanted: string): Normalized {
  return {
    ok: false,
    diagnostic: {
      code: 'UNIT_UNCONVERTIBLE',
      message: `unit "${q.unit}" cannot be converted to ${wanted}; value kept in raw position`,
      detail: { value: q.value, unit: q.unit },
    },
  };
}
