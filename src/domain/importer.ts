import { FormatError } from "../shared/types.ts";
import type {
  AmplitudeFrame,
  CalibrationPlane,
  CutEdit,
  CutEditHistory,
  GridDims,
  IlluminationGeometry,
  InvalidityMask,
  RawBody,
  RawEnvelope,
  RawKind,
  Scalar,
  WavelengthSpec,
  WrappedPhaseFrame
} from "../shared/types.ts";

/**
 * Small, copy-pasteable frame format:
 *
 *   frame: wrapped_phase
 *   dims: 3x4
 *   unit: rad
 *   -3.0  2.9  0.1  -0.2
 *   ...
 *
 * Mask rows use 0/1 tokens. Frames may contain "." for missing raw readings;
 * the raw representation is preserved and diagnostics describe every problem
 * instead of silently dropping values.
 */

const TWO_PI = 2 * Math.PI;

function requireHeader(lines: string[], key: string, lineNo: number): string {
  const hit = lines.find((l) => l.toLowerCase().startsWith(key + ":"));
  if (!hit) {
    throw new FormatError(`missing required header "${key}" (checked at line ${lineNo})`, [
      `expected "${key}: ..." header`
    ]);
  }
  return hit.slice(key.length + 1).trim();
}

function parseDims(text: string): GridDims {
  const m = /^(\d+)\s*[x,]\s*(\d+)$/.exec(text);
  if (!m) {
    throw new FormatError(`bad dims "${text}", expected ROWSxCOLS`, [`dims must look like 4x6`]);
  }
  const rows = Number(m[1]);
  const cols = Number(m[2]);
  if (rows < 2 || cols < 2) {
    throw new FormatError(`dims ${rows}x${cols} must be at least 2x2 (residues need 2x2 loops)`, [
      "frames smaller than 2x2 cannot contain an elementary loop"
    ]);
  }
  return { rows, cols };
}

function gridLines(lines: string[]): string[] {
  return lines.filter((l) => l.trim() !== "" && !/^[a-z_]+\s*:/i.test(l.trim()));
}

function checkRowCount(rows: string[], dims: GridDims): void {
  if (rows.length !== dims.rows) {
    throw new FormatError(`expected ${dims.rows} grid rows, got ${rows.length}`, [
      `row count ${rows.length} != dims.rows ${dims.rows}`
    ]);
  }
}

export function parseWrappedPhase(text: string): WrappedPhaseFrame {
  const lines = text.split(/\r?\n/);
  const dims = parseDims(requireHeader(lines, "dims", 0));
  const rows = gridLines(lines);
  checkRowCount(rows, dims);
  const diagnostics: string[] = [];
  const values: string[] = [];
  rows.forEach((row, r) => {
    const toks = row.trim().split(/[\s,]+/).filter(Boolean);
    if (toks.length !== dims.cols) {
      throw new FormatError(`row ${r} has ${toks.length} tokens, expected ${dims.cols}`, [
        `row ${r}: token count ${toks.length} != dims.cols ${dims.cols}`
      ]);
    }
    toks.forEach((tok, c) => {
      if (tok === "." || tok === "nan") {
        values.push(tok);
        return;
      }
      const v = Number(tok);
      if (!Number.isFinite(v)) {
        throw new FormatError(`non-numeric phase "${tok}" at r=${r},c=${c}`, [
          `r=${r},c=${c}: "${tok}" is not a finite number or missing token "."`
        ]);
      }
      if (v <= -TWO_PI || v > TWO_PI) {
        diagnostics.push(`r=${r},c=${c}: phase ${tok} rad lies outside (-2pi,2pi]; wrapping happens only in derived layer`);
      }
      values.push(tok);
    });
  });
  if (diagnostics.length) {
    throw new FormatError(`wrapped phase values out of principal range`, diagnostics);
  }
  return { dims, unit: "rad", coordinateBasis: "pixel#top-left", values };
}

export function parseAmplitude(text: string): AmplitudeFrame {
  const lines = text.split(/\r?\n/);
  const dims = parseDims(requireHeader(lines, "dims", 0));
  const unitRaw = lines.find((l) => l.toLowerCase().startsWith("unit:"));
  const unit = unitRaw ? unitRaw.slice(5).trim() : "a.u.";
  const rows = gridLines(lines);
  checkRowCount(rows, dims);
  const values: string[] = [];
  rows.forEach((row, r) => {
    const toks = row.trim().split(/[\s,]+/).filter(Boolean);
    if (toks.length !== dims.cols) {
      throw new FormatError(`row ${r} has ${toks.length} tokens, expected ${dims.cols}`, [
        `amplitude row ${r}: token count mismatch`
      ]);
    }
    toks.forEach((tok, c) => {
      const v = Number(tok);
      if (tok === "." || tok === "nan") {
        values.push(tok);
        return;
      }
      if (!Number.isFinite(v) || v < 0) {
        throw new FormatError(`bad amplitude "${tok}" at r=${r},c=${c}`, [
          `r=${r},c=${c}: amplitude must be a finite, non-negative number (or ".")`
        ]);
      }
      values.push(tok);
    });
  });
  return { dims, unit, coordinateBasis: "pixel#top-left", values };
}

export function parseMask(text: string): InvalidityMask {
  const lines = text.split(/\r?\n/);
  const dims = parseDims(requireHeader(lines, "dims", 0));
  const rows = gridLines(lines);
  checkRowCount(rows, dims);
  const values: number[] = [];
  rows.forEach((row, r) => {
    const toks = row.trim().split(/[\s,]+/).filter(Boolean);
    if (toks.length !== dims.cols) {
      throw new FormatError(`mask row ${r} has ${toks.length} tokens, expected ${dims.cols}`, [
        `mask row ${r}: token count mismatch`
      ]);
    }
    toks.forEach((tok, c) => {
      if (tok !== "0" && tok !== "1") {
        throw new FormatError(`mask token "${tok}" at r=${r},c=${c} is not 0 or 1`, [
          `r=${r},c=${c}: invalidity mask accepts only 0 (valid) / 1 (invalid)`
        ]);
      }
      values.push(Number(tok));
    });
  });
  return { dims, coordinateBasis: "pixel#top-left", values };
}

const SI_FACTOR: Record<string, number> = {
  m: 1,
  nm: 1e-9,
  um: 1e-6,
  "µm": 1e-6,
  mm: 1e-3,
  rad: 1,
  deg: Math.PI / 180,
  "°": Math.PI / 180,
  "1": 1,
  count: 1,
  "a.u.": 1
};

export function scalar(text: string, unit: string, basis?: string): Scalar {
  const diagnostics: string[] = [];
  let siValue: number | undefined;
  const v = Number(text);
  if (!Number.isFinite(v)) {
    diagnostics.push(`cannot convert "${text}" ${unit} to SI: non-numeric value kept at origin`);
  } else if (!(unit in SI_FACTOR)) {
    diagnostics.push(`no known SI conversion for unit "${unit}": value kept as ${text} ${unit}`);
  } else {
    siValue = v * SI_FACTOR[unit];
  }
  return { value: text, unit, ...(basis ? { basis } : {}), diagnostics, ...(siValue !== undefined ? { siValue } : {}) };
}

export function parseWavelength(text: string): WavelengthSpec {
  const lines = text.split(/\r?\n/);
  const value = requireHeader(lines, "wavelength", 0);
  const unit = requireHeader(lines, "unit", 0);
  const specLine = lines.find((l) => l.toLowerCase().startsWith("spec_version:"));
  const specVersion = specLine ? specLine.slice("spec_version:".length).trim() : "wavelength-rules-v1";
  return { wavelength: scalar(value, unit, "vacuum wavelength"), specVersion };
}

export function parseGeometry(text: string): IlluminationGeometry {
  const lines = text.split(/\r?\n/);
  const incV = requireHeader(lines, "incidence_angle", 0);
  const incU = requireHeader(lines, "incidence_unit", 0);
  const azV = requireHeader(lines, "azimuth_angle", 0);
  const azU = requireHeader(lines, "azimuth_unit", 0);
  const basisLine = lines.find((l) => l.toLowerCase().startsWith("vector_basis:"));
  const vectorBasis = basisLine ? basisLine.slice("vector_basis:".length).trim() : "optical-axis#z";
  return {
    incidenceAngle: scalar(incV, incU, "from surface normal"),
    azimuthAngle: scalar(azV, azU, "in surface plane"),
    vectorBasis
  };
}

export function parseCalibration(text: string): CalibrationPlane {
  const lines = text.split(/\r?\n/);
  const get = (key: string) => requireHeader(lines, key, 0);
  return {
    z0: scalar(get("z0"), get("z0_unit"), "reference plane height"),
    slopeR: scalar(get("slope_r"), "1", "height per pixel, +row direction"),
    slopeC: scalar(get("slope_c"), "1", "height per pixel, +col direction"),
    pixelPitch: scalar(get("pixel_pitch"), get("pixel_pitch_unit"), "centre-to-centre pixel spacing"),
    basis: "pixel#top-left"
  };
}

export function parseCutHistory(text: string): CutEditHistory {
  const lines = text.split(/\r?\n/);
  const edits: CutEdit[] = [];
  const seen = new Set<string>();
  lines
    .filter((l) => l.trim().startsWith("edit:"))
    .forEach((line, i) => {
      const body = line.slice("edit:".length).trim();
      const parts = body.split(";").map((p) => p.trim());
      const get = (k: string) => {
        const hit = parts.find((p) => p.startsWith(k + "="));
        if (!hit) throw new FormatError(`cut edit #${i} misses "${k}"`, [`edit line: ${body}`]);
        return hit.slice(k.length + 1).trim();
      };
      const action = get("action");
      if (action !== "place" && action !== "remove") {
        throw new FormatError(`cut edit #${i} has bad action "${action}"`, [`action must be place|remove`]);
      }
      const em = /^\((\d+),(\d+)\)-\((\d+),(\d+)\)$/.exec(get("edge"));
      if (!em) {
        throw new FormatError(`cut edit #${i} has bad edge`, [`edge must be (r,c)-(r,c)`]);
      }
      const edge = {
        a: { r: Number(em[1]), c: Number(em[2]) },
        b: { r: Number(em[3]), c: Number(em[4]) }
      };
      const key = `${edge.a.r},${edge.a.c}-${edge.b.r},${edge.b.c}`;
      if (seen.has(key) && action === "place") {
        throw new FormatError(`cut edit #${i} duplicates an existing cut on ${key}`, [
          "edits are an append-only history; a placed cut cannot be placed again without removal"
        ]);
      }
      if (action === "place") seen.add(key);
      else seen.delete(key);
      edits.push({
        editId: get("id"),
        at: Number(get("at")),
        action,
        edge,
        ...(parts.find((p) => p.startsWith("k=")) ? { cycleOffset: Number(get("k")) } : {}),
        reason: get("reason"),
        operator: get("operator")
      });
    });
  if (!edits.length) {
    throw new FormatError("cut edit history has no edit: lines", ['expected lines like "edit: id=e1; ..."']);
  }
  return { edits };
}

const PARSERS: Record<RawKind, (text: string) => RawBody> = {
  wrapped_phase: parseWrappedPhase,
  amplitude: parseAmplitude,
  invalidity_mask: parseMask,
  wavelength: parseWavelength,
  illumination_geometry: parseGeometry,
  calibration_plane: parseCalibration,
  cut_edit_history: parseCutHistory
};

export function importRaw(kind: RawKind, sourceText: string): RawEnvelope {
  const parser = PARSERS[kind];
  if (!parser) {
    throw new FormatError(`unknown raw entity kind "${kind}"`, [
      `allowed kinds: ${Object.keys(PARSERS).join(", ")}`
    ]);
  }
  return { kind, body: parser(sourceText), sourceText };
}
