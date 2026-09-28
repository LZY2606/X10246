/** 包裹/解包裹基础数学。包裹域 (-pi, pi]。 */
export const TWO_PI = 2 * Math.PI;

/** 把任意角度包裹到 (-pi, pi] */
export function wrap(rad: number): number {
  let w = rad % TWO_PI;
  if (w <= -Math.PI) w += TWO_PI;
  else if (w > Math.PI) w -= TWO_PI;
  return w;
}

/** 包裹梯度：跨越一条边时实际采用的相位增量 */
export function wrappedDelta(a: number, b: number): number {
  return wrap(b - a);
}

/** 沿已知包裹梯度推进时需要加入的整周数 */
export function wrapCountAcross(prevUnwrapped: number, wrappedNeighbor: number): number {
  const targetApprox = prevUnwrapped + wrap(wrappedNeighbor - (prevUnwrapped % TWO_PI));
  return Math.round((targetApprox - prevUnwrapped) / TWO_PI);
}

export function nearInt(x: number, tol = 1e-6): boolean {
  return Math.abs(x - Math.round(x)) <= tol;
}
