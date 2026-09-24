export const TWO_PI = 2 * Math.PI;

export function wrap(phi: number): number {
  return phi - TWO_PI * Math.round(phi / TWO_PI);
}

export function principalDelta(a: number, b: number): number {
  let d = a - b;
  d -= TWO_PI * Math.round(d / TWO_PI);
  return d;
}
