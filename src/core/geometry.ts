import type {
  HeightField,
  HeightPixelStatus,
  IlluminationGeometry,
  InvalidMask,
  UnwrappedPhase,
  Wavelength
} from "../shared/types";

const UNIT_TO_M: Record<string, number> = {
  nm: 1e-9,
  um: 1e-6,
  µm: 1e-6,
  mm: 1e-3,
  m: 1
};

/** 单位规范化只发生在派生层；无法识别的单位返回 null，原始值留在输入层原位 */
export function toMeters(raw: { value: number; unit: string }): number | null {
  const factor = UNIT_TO_M[raw.unit.trim()];
  return factor === undefined ? null : raw.value * factor;
}

export function toRadians(raw: { value: number; unit: string }): number | null {
  const u = raw.unit.trim();
  if (u === "rad" || u === "radian" || u === "radians") return raw.value;
  if (u === "deg" || u === "degree" || u === "degrees" || u === "°") return (raw.value * Math.PI) / 180;
  return null;
}

export interface HeightContext {
  wavelength: Wavelength | null;
  geometry: IlluminationGeometry | null;
  /** 波长版本是否唯一可解析（多版本并存且未裁定 → false） */
  wavelengthResolved: boolean;
}

/**
 * 高度转换链 φ → z：
 *   sensitivity = 2π / (λ · (1 + cos θ))   （反射式敏感度模型）
 *   z = φ_unwrap / sensitivity = φ · λ(1+cosθ) / 2π
 * 无法转换的像素留在 null 并给出逐像素状态，绝不为画图而丢值。
 */
export function convertToHeight(
  unwrapped: UnwrappedPhase,
  mask: InvalidMask,
  ctx: HeightContext
): HeightField {
  const n = unwrapped.rows * unwrapped.cols;
  const z: (number | null)[] = new Array(n).fill(null);
  const status: HeightPixelStatus[] = new Array(n).fill("masked");

  let lambdaM: number | null = null;
  let cosTheta: number | null = null;
  let factor: number | null = null;
  let globalStatus: HeightPixelStatus | null = null;

  if (!ctx.wavelength || !ctx.wavelengthResolved) {
    globalStatus = "wavelength_unresolved";
  } else {
    lambdaM = toMeters(ctx.wavelength.lambda);
    if (lambdaM === null) globalStatus = "wavelength_unresolved";
  }
  if (globalStatus === null) {
    if (!ctx.geometry || ctx.geometry.sensitivityDirection === null) {
      globalStatus = "geometry_unresolved";
    } else {
      const theta = toRadians(ctx.geometry.incidence);
      cosTheta = theta === null ? null : Math.cos(theta);
      if (cosTheta === null) globalStatus = "geometry_unresolved";
    }
  }
  if (globalStatus === null && lambdaM !== null && cosTheta !== null) {
    factor = (lambdaM * (1 + cosTheta)) / (2 * Math.PI);
  }

  for (let p = 0; p < n; p++) {
    const phi = unwrapped.phaseRad[p];
    if (mask.invalid[p] || phi === null) {
      status[p] = mask.invalid[p] ? "masked" : "unknown_low_amplitude";
      continue;
    }
    if (globalStatus) {
      status[p] = globalStatus;
      continue;
    }
    status[p] = "ok";
    z[p] = factor! * phi;
  }

  return {
    kind: "height_field",
    rows: unwrapped.rows,
    cols: unwrapped.cols,
    z,
    unit: "m",
    coordSystem: "pixel:top-left",
    status,
    sensitivityFactor: factor === null ? null : 2 * Math.PI / (lambdaM! * (1 + cosTheta!))
  };
}
