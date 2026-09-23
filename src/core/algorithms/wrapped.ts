// 包裹相位基本运算（rad，主值 [-pi, pi)）

export const TWO_PI = Math.PI * 2;

/** 包回主值：[-pi, pi) */
export function wrapToPrincipal(phi: number): number {
  let w = phi % TWO_PI;
  if (w >= Math.PI) w -= TWO_PI;
  if (w < -Math.PI) w += TWO_PI;
  return w;
}

/** 包裹差：从像素 a 走向 b 时“看到”的最小相位增量 */
export function wrappedStep(phiA: number, phiB: number): number {
  return wrapToPrincipal(phiB - phiA);
}

/** 跨 ±pi 边界检测：原始差与包裹差符号相反且幅值大，即发生了一次整周跨越 */
export function crossesWrapBoundary(phiA: number, phiB: number): boolean {
  const raw = phiB - phiA;
  const wrapped = wrappedStep(phiA, phiB);
  return Math.abs(raw - wrapped) > Math.PI - 1e-9;
}

/** 把一段累积相位增量规整到最接近的整周偏移（turn） */
export function nearestIntegerTurns(accumulatedRad: number): number {
  return Math.round(accumulatedRad / TWO_PI);
}
