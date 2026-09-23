/**
 * 领域量单位与坐标基准。导入时保留原始表示；只有派生层才做规范化。
 */
export interface UnitTag {
  /** 计量单位，例如 "rad"、"nm"、"count"、"1"（无量纲）。 */
  unit: string;
}

export interface CoordinateFrame {
  /** 坐标基准稳定身份。 */
  frameId: string;
  /** 像素 (0,0) 在物理坐标系中的原点。 */
  origin: [number, number];
  /** 列、行方向单位向量对应的物理步长 [dx, dy]（每像素）。 */
  pixelPitch: [number, number];
  /** 物理长度单位，例如 "um"。 */
  lengthUnit: string;
}

export const FRAME_PIXEL: CoordinateFrame = {
  frameId: "frame_pixel_index",
  origin: [0, 0],
  pixelPitch: [1, 1],
  lengthUnit: "px",
};

const KNOWN_LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  mm: 1_000_000,
  m: 1_000_000_000,
};

export interface UnitConversion {
  ok: boolean;
  factor?: number;
  diagnostic?: ConversionDiagnostic;
}

export interface ConversionDiagnostic {
  code: "UNKNOWN_UNIT" | "INCOMPATIBLE_DIMENSION";
  message: string;
  rawUnit: string;
  targetUnit: string;
}

/** 派生层规范化转换；无法转换时返回诊断而不是丢值。 */
export function convertLength(value: number, fromUnit: string, toUnit: string): UnitConversion {
  const from = KNOWN_LENGTH_TO_NM[fromUnit];
  const to = KNOWN_LENGTH_TO_NM[toUnit];
  if (from === undefined || to === undefined) {
    return {
      ok: false,
      diagnostic: {
        code: "UNKNOWN_UNIT",
        message: `无法在 "${fromUnit}" 与 "${toUnit}" 之间转换，值保留原始表示`,
        rawUnit: fromUnit,
        targetUnit: toUnit,
      },
    };
  }
  return { ok: true, factor: from / to };
}
