import { phaseToRadian, LENGTH_TO_METER_FALLBACK } from "./units.js";
import type {
  AmplitudeFrameV,
  CalibrationPlaneV,
  CellDiagnostic,
  CutEditHistoryV,
  CutEditRecord,
  IlluminationGeometryV,
  InvalidMaskV,
  QualityScoreFrameV,
  WavelengthSpecV,
  WrappedPhaseFrameV
} from "./entities.js";
import type { GridSpec } from "./grid.js";
import type { CoordBasis, LengthUnit, PhaseUnit } from "./units.js";

export class FormatError extends Error {
  constructor(
    readonly code:
      | "GRID_MISMATCH"
      | "UNKNOWN_UNIT"
      | "MALFORMED_HEADER"
      | "BAD_TOKEN"
      | "MISSING_SECTION",
    message: string,
    readonly section?: string,
    readonly index?: number
  ) {
    super(message);
    this.name = "FormatError";
  }
}

export interface FrameInput {
  grid: GridSpec;
  tokens: string[];
}

function expectedCells(grid: GridSpec) {
  const n = grid.cols * grid.rows;
  if (!Number.isInteger(grid.cols) || grid.cols <= 0 || !Number.isInteger(grid.rows) || grid.rows <= 0) {
    throw new FormatError("MALFORMED_HEADER", "grid cols/rows must be positive integers", "grid");
  }
  return n;
}

export function parseWrappedPhase(input: FrameInput, unit: PhaseUnit): Omit<
  WrappedPhaseFrameV,
  "entityId" | "version" | "parentVersion" | "createdAt" | "immutable" | "blobId"
> {
  const n = expectedCells(input.grid);
  if (input.tokens.length !== n) {
    throw new FormatError("GRID_MISMATCH", `expected ${n} phase tokens, got ${input.tokens.length}`, "phase", input.tokens.length);
  }
  const rawTokens: string[] = [];
  const wrappedRadians: number[] = [];
  const diagnostics: CellDiagnostic[] = [];
  input.tokens.forEach((tok, index) => {
    rawTokens.push(tok);
    const trimmed = tok.trim();
    const numeric = Number(trimmed);
    if (trimmed === "" || Number.isNaN(numeric)) {
      wrappedRadians.push(NaN);
      diagnostics.push({
        index,
        code: "NON_NUMERIC_RAW",
        rawRepresentation: tok,
        message: "phase token is not numeric; original representation retained, no value invented"
      });
      return;
    }
    let value = numeric;
    if (unit === "degree" && !(value >= -360 && value <= 360)) {
      diagnostics.push({
        index,
        code: "OUT_OF_PHASE_RANGE",
        rawRepresentation: tok,
        message: "degree phase outside [-360,360]; kept in place with diagnostic"
      });
    }
    if (unit === "radian" && !(value >= -2 * Math.PI - 1e-9 && value <= 2 * Math.PI + 1e-9)) {
      diagnostics.push({
        index,
        code: "OUT_OF_PHASE_RANGE",
        rawRepresentation: tok,
        message: "radian phase outside [-2pi,2pi]; kept in place with diagnostic"
      });
    }
    wrappedRadians.push(phaseToRadian(value, unit));
  });
  return { kind: "WrappedPhaseFrame", grid: input.grid, phaseUnit: unit, rawTokens, wrappedRadians, diagnostics };
}

export function parseAmplitude(
  input: FrameInput,
  unit: "adu" | "normalized",
  lowAmplitudeThreshold: number
): Omit<AmplitudeFrameV, "entityId" | "version" | "parentVersion" | "createdAt" | "immutable" | "blobId"> {
  const n = expectedCells(input.grid);
  if (input.tokens.length !== n) {
    throw new FormatError("GRID_MISMATCH", `expected ${n} amplitude tokens, got ${input.tokens.length}`, "amplitude", input.tokens.length);
  }
  const amplitudes: number[] = [];
  const rawTokens: string[] = [];
  const diagnostics: CellDiagnostic[] = [];
  input.tokens.forEach((tok, index) => {
    rawTokens.push(tok);
    const numeric = Number(tok.trim());
    if (tok.trim() === "" || Number.isNaN(numeric)) {
      amplitudes.push(NaN);
      diagnostics.push({
        index,
        code: "NON_NUMERIC_RAW",
        rawRepresentation: tok,
        message: "amplitude token not numeric"
      });
      return;
    }
    if (unit === "normalized" && (numeric < 0 || numeric > 1)) {
      diagnostics.push({
        index,
        code: "OUT_OF_PHASE_RANGE",
        rawRepresentation: tok,
        message: "normalized amplitude outside [0,1]"
      });
    }
    amplitudes.push(numeric);
  });
  return {
    kind: "AmplitudeFrame",
    grid: input.grid,
    amplitudeUnit: unit,
    amplitudes,
    rawTokens,
    lowAmplitudeThreshold,
    diagnostics
  };
}

export function parseQualityScores(input: FrameInput, unit: "snr_db" | "normalized"): Omit<
  QualityScoreFrameV,
  "entityId" | "version" | "parentVersion" | "createdAt" | "immutable" | "blobId"
> {
  const n = expectedCells(input.grid);
  if (input.tokens.length !== n) {
    throw new FormatError("GRID_MISMATCH", `expected ${n} score tokens, got ${input.tokens.length}`, "quality", input.tokens.length);
  }
  const scores: number[] = [];
  const rawTokens: string[] = [];
  const diagnostics: CellDiagnostic[] = [];
  input.tokens.forEach((tok, index) => {
    rawTokens.push(tok);
    const numeric = Number(tok.trim());
    if (tok.trim() === "" || Number.isNaN(numeric)) {
      scores.push(NaN);
      diagnostics.push({ index, code: "NON_NUMERIC_RAW", rawRepresentation: tok, message: "score token not numeric" });
    } else {
      scores.push(numeric);
    }
  });
  return { kind: "QualityScoreFrame", grid: input.grid, scoreUnit: unit, scores, rawTokens, diagnostics };
}

export function parseMask(input: FrameInput): Omit<
  InvalidMaskV,
  "entityId" | "version" | "parentVersion" | "createdAt" | "immutable" | "blobId"
> {
  const n = expectedCells(input.grid);
  if (input.tokens.length !== n) {
    throw new FormatError("GRID_MISMATCH", `expected ${n} mask tokens, got ${input.tokens.length}`, "mask", input.tokens.length);
  }
  const invalid: boolean[] = [];
  const rawTokens: string[] = [];
  const diagnostics: CellDiagnostic[] = [];
  input.tokens.forEach((tok, index) => {
    rawTokens.push(tok);
    const t = tok.trim();
    if (t === "1" || t === "X" || t === "x" || t.toLowerCase() === "invalid") invalid.push(true);
    else if (t === "0" || t === "." || t.toLowerCase() === "valid") invalid.push(false);
    else {
      invalid.push(true);
      diagnostics.push({ index, code: "MASK_INVALID", rawRepresentation: tok, message: "mask token unrecognized; treated as invalid, original retained" });
    }
  });
  return { kind: "InvalidMask", grid: input.grid, invalid, rawTokens, diagnostics };
}

export function parseWavelength(rawValue: string, unit: string): Omit<
  WavelengthSpecV,
  "entityId" | "version" | "parentVersion" | "createdAt" | "immutable"
> {
  const numeric = Number(rawValue.trim());
  if (!(unit in LENGTH_TO_METER_FALLBACK)) {
    throw new FormatError("UNKNOWN_UNIT", `unknown wavelength unit '${unit}'`, "wavelength");
  }
  const lu = unit as LengthUnit;
  if (rawValue.trim() === "" || Number.isNaN(numeric) || numeric <= 0) {
    return {
      kind: "WavelengthSpec",
      wavelength: { value: Number.isNaN(numeric) ? 0 : numeric, unit: lu },
      effectiveWavelengthM: null,
      diagnostic: {
        index: -1,
        code: "UNCONVERTIBLE_UNIT",
        rawRepresentation: `${rawValue} ${unit}`,
        message: "wavelength not convertible to meters; raw value kept, height conversion blocked"
      }
    };
  }
  return {
    kind: "WavelengthSpec",
    wavelength: { value: numeric, unit: lu },
    effectiveWavelengthM: numeric * LENGTH_TO_METER_FALLBACK[lu],
    diagnostic: null
  };
}

export function parseGeometry(angleDegrees: number, sensitivityFactorOverride?: number): Omit<
  IlluminationGeometryV,
  "entityId" | "version" | "parentVersion" | "createdAt" | "immutable"
> {
  const angleRad = (angleDegrees * Math.PI) / 180;
  const sensitivityFactor = sensitivityFactorOverride ?? 1 / (2 * Math.cos(angleRad));
  const coordBasis: CoordBasis = {
    id: "basis.camera_xy_z",
    frame: "camera optical frame",
    axes: ["sensor_x", "sensor_y", "optical_z"]
  };
  return {
    kind: "IlluminationGeometry",
    incidenceAngle: { value: angleDegrees, unit: "degree" },
    sensitivityFactor,
    coordBasis
  };
}

export function parseCalibrationPlane(
  grid: GridSpec,
  coefficientsM: { a: number; b: number; c: number },
  heightUnit: LengthUnit,
  residualRmsM = 0
): Omit<CalibrationPlaneV, "entityId" | "version" | "parentVersion" | "createdAt" | "immutable"> {
  return {
    kind: "CalibrationPlane",
    grid,
    method: "tilted_plane",
    coefficientsM,
    heightUnit,
    coordBasis: { id: "basis.camera_xy_z", frame: "camera optical frame", axes: ["sensor_x", "sensor_y", "optical_z"] },
    residualRmsM
  };
}

export function parseCutHistory(edits: Omit<CutEditRecord, "editId">[]): Omit<
  CutEditHistoryV,
  "entityId" | "version" | "parentVersion" | "createdAt" | "immutable"
> {
  return {
    kind: "CutEditHistory",
    edits: edits.map((e, i) => ({ ...e, editId: e.editId ?? `cutedit_${i.toString().padStart(3, "0")}` }))
  };
}
