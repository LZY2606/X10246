export function toNumber(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

export function wrapRadians(phase: number): number {
  const wrapped = phase - 2 * Math.PI * Math.floor((phase + Math.PI) / (2 * Math.PI));
  return toNumber(wrapped);
}

export function wrappedDifference(to: number, from: number): number {
  return wrapRadians(to - from);
}

export function convertNanometers(value: number, unit: 'nanometer' | 'millimeter'): number {
  return unit === 'millimeter' ? value * 1_000_000 : value;
}
