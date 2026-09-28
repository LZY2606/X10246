import type { Qty, UnitName } from './types.js';

const TO_NANOMETER: Partial<Record<UnitName, number>> = {
  nanometer: 1,
  micrometer: 1e3,
  millimeter: 1e6,
  meter: 1e9
};

/** 派生层规范化；无法转换的值留在原位置（调用方负责记诊断）。 */
export function toNanometers(q: Qty): number | null {
  const f = TO_NANOMETER[q.unit];
  if (f === undefined || !Number.isFinite(q.value)) return null;
  return q.value * f;
}

/** 包裹到 (-π, π]。 */
export function wrapPi(x: number): number {
  let y = x % (2 * Math.PI);
  if (y <= -Math.PI) y += 2 * Math.PI;
  if (y > Math.PI) y -= 2 * Math.PI;
  return y;
}

/**
 * 高度转换链采用的领域约定（反射式斜入射，单束物光近似）：
 *   相位差 φ(rad) 对应光程差 OPD = λ · φ / (2π) ·（相位到 OPD 的符号约定 +1）
 *   反射式：OPD = 2 · h · cos(θ)  ⇒  h = OPD / (2 cos θ)
 * 正入射 θ=0 退化为 h = OPD/2。所有系数在此集中并显式出现在 chain 的 formula 中。
 */
export function heightFromPhase(
  phaseRad: number,
  wavelengthNm: number,
  incidenceDeg: number
): number {
  const opdNm = (wavelengthNm * phaseRad) / (2 * Math.PI);
  const cosT = Math.cos((incidenceDeg * Math.PI) / 180);
  const heightNm = opdNm / (2 * cosT);
  return heightNm / 1000; // µm
}

export function calibratedResidual(
  heightUm: number,
  col: number,
  row: number,
  plane: { a: number; b: number; c: number; coefficientUnit: string }
): number {
  const planeUm = plane.coefficientUnit === 'meter_per_meter'
    ? plane.a * col + plane.b * row + plane.c
    : plane.a * col + plane.b * row + plane.c;
  return heightUm - planeUm;
}
