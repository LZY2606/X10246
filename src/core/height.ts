import { makeFragment, type GridFragment } from "./grid";
import type { CalibrationPlane, IlluminationGeometry, Wavelength } from "./types";
import { convertLength } from "./units";

export const HEIGHT_ALGO = { algorithmName: "phase-to-height-chain", algorithmVersion: "1.0.0" } as const;

export interface HeightResult {
  heightFragment: GridFragment;
  unknownFragment: GridFragment;
  keptRaw: Array<{ at: { r: number; c: number }; reason: string }>;
  outputUnit: string;
  formula: string;
}

/**
 * 高度转换链：
 *   h = lambda * phi_unwrapped / (4*pi*cos(theta)) - (a*x + b*y + c)
 * 反射式离轴几何。无法转换单位 / 未知像素留在原位置并附诊断，绝不为画图丢值。
 */
export function phaseToHeight(
  unwrapped: GridFragment,
  unknownBits: GridFragment,
  wavelength: Wavelength,
  geometry: IlluminationGeometry,
  plane: CalibrationPlane,
): HeightResult {
  const outputUnit = "nm";
  const conv = convertLength(wavelength.value, wavelength.unit, outputUnit);
  const keptRaw: Array<{ at: { r: number; c: number }; reason: string }> = [];
  const theta = (geometry.incidenceAngle.value * Math.PI) / 180;
  const w = unwrapped.width;
  const h = unwrapped.height;
  const heightData = new Array<number>(w * h).fill(0);
  const unknownChars: string[] = new Array(w * h).fill("0");
  const phaseData = unwrapped.data as number[];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const isUnknown = (unknownBits.data as string).charAt(i) === "1";
      if (isUnknown) {
        unknownChars[i] = "1";
        keptRaw.push({ at: { r, c }, reason: "SOURCE_PHASE_UNKNOWN_LOW_AMPLITUDE_OR_INVALID" });
        continue;
      }
      if (!conv.ok) {
        unknownChars[i] = "1";
        keptRaw.push({ at: { r, c }, reason: `UNCONVERTIBLE_UNIT_KEPT_IN_PLACE: ${conv.diagnostic?.code ?? ""}` });
        continue;
      }
      const lambdaNm = wavelength.value * (conv.factor as number);
      const phi = phaseData[i] as number;
      const x = c;
      const y = r;
      const height = (lambdaNm * phi) / (4 * Math.PI * Math.cos(theta)) - (plane.coefficients.a * x + plane.coefficients.b * y + plane.coefficients.c);
      heightData[i] = Number(height.toFixed(6));
    }
  }
  return {
    heightFragment: makeFragment("f64", w, h, heightData),
    unknownFragment: makeFragment("bits", w, h, unknownChars.join("")),
    keptRaw,
    outputUnit,
    formula: "h = lambda * phi_unwrapped / (4*pi*cos(theta)) - (a*x+b*y+c)",
  };
}
