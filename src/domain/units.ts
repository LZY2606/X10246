export type PhaseUnit = "radian" | "degree";
export type LengthUnit = "nm" | "um" | "mm" | "m";
export type ScalarUnit = "count" | "normalized" | "snr_db" | "pixel" | "unitless" | "adu";
export type Unit = PhaseUnit | LengthUnit | ScalarUnit;

export const LENGTH_TO_M: Record<LengthUnit, number> = {
  nm: 1e-9,
  um: 1e-6,
  mm: 1e-3,
  m: 1
};

export const LENGTH_TO_METER_FALLBACK = LENGTH_TO_M;

export function phaseToRadian(value: number, unit: PhaseUnit): number {
  return unit === "degree" ? (value * Math.PI) / 180 : value;
}

export function radianToPhase(value: number, unit: PhaseUnit): number {
  return unit === "degree" ? (value * 180) / Math.PI : value;
}

export function lengthToMeters(value: number, unit: LengthUnit): number {
  return value * LENGTH_TO_M[unit];
}

export interface CoordBasis {
  id: string;
  frame: string;
  axes: [string, string, string];
}

export const CAMERA_BASIS: CoordBasis = {
  id: "basis.camera_xy_z",
  frame: "camera optical frame",
  axes: ["sensor_x", "sensor_y", "optical_z"]
};
