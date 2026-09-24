import type { UnitSpec } from '../domain/types.js';

/** 已知单位白名单（保留原始表示；这里只在派生层做换算校验） */
export const KNOWN_UNITS: Record<string, string[]> = {
  angle: ['rad', 'deg'],
  length: ['m', 'mm', 'um', 'nm'],
  dimensionless: ['a.u.', 'fringe', 'px', 'count'],
  wavenumber: ['1/m'],
  none: ['none']
};

export function isKnownUnit(unit: UnitSpec): boolean {
  return Boolean(KNOWN_UNITS[unit.kind]?.includes(unit.symbol));
}

export function toMeters(value: number, symbol: string): number | null {
  switch (symbol) {
    case 'm': return value;
    case 'mm': return value * 1e-3;
    case 'um': return value * 1e-6;
    case 'nm': return value * 1e-9;
    default: return null;
  }
}
