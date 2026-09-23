import {
  RAW_KINDS,
  type CutEdit,
  type GridPayload,
  type RawKind,
  type RawPayload
} from './types.js';
import { dimensionOf } from './units.js';

export class FormatValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Import format error:\n - ${issues.join('\n - ')}`);
    this.name = 'FormatValidationError';
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
  path: string
): number | null {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push(`${path}.${key} must be a finite number`);
    return null;
  }
  return value;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
  path: string
): string | null {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${path}.${key} must be a non-empty string`);
    return null;
  }
  return value;
}

function parseQuantity(
  record: Record<string, unknown>,
  key: string,
  issues: string[],
  path: string
) {
  const raw = record[key];
  if (!isRecord(raw)) {
    issues.push(`${path}.${key} must be {value, unit, basis}`);
    return null;
  }
  const value = requireNumber(raw, 'value', issues, `${path}.${key}`);
  const unit = requireString(raw, 'unit', issues, `${path}.${key}`);
  const basis = requireString(raw, 'basis', issues, `${path}.${key}`);
  if (value === null || unit === null || basis === null) return null;
  return { value, unit, basis };
}

function parseSubQuantity(
  record: Record<string, unknown>,
  key: 'origin' | 'pixelPitch',
  issues: string[],
  path: string
) {
  const raw = record[key];
  if (!isRecord(raw)) {
    issues.push(`${path}.${key} must contain x/y quantities`);
    return null;
  }
  const x = parseQuantity(raw, 'x', issues, `${path}.${key}`);
  const y = parseQuantity(raw, 'y', issues, `${path}.${key}`);
  return x && y ? { x, y } : null;
}

function parseGrid(
  record: Record<string, unknown>,
  kind: RawKind,
  issues: string[],
  path: string
): GridPayload | null {
  const grid = record['grid'];
  if (!isRecord(grid)) {
    issues.push(`${path}.grid must be {rows, cols, origin, pixelPitch}`);
    return null;
  }
  const rows = requireNumber(grid, 'rows', issues, `${path}.grid`);
  const cols = requireNumber(grid, 'cols', issues, `${path}.grid`);
  if (rows === null || cols === null) return null;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
    issues.push(`${path}.grid rows/cols must be positive integers`);
    return null;
  }
  const origin = parseSubQuantity(grid, 'origin', issues, path);
  const pixelPitch = parseSubQuantity(grid, 'pixelPitch', issues, path);
  if (!origin || !pixelPitch) return null;

  const values = record['values'];
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'number')) {
    issues.push(`${path}.values must be an array of numbers (use nodata positions for missing samples)`);
    return null;
  }
  if (values.length !== rows * cols) {
    issues.push(`${path}.values length ${String(values.length)} != rows*cols ${rows * cols}`);
    return null;
  }
  const nodata = record['nodata'];
  if (
    nodata !== undefined &&
    (!Array.isArray(nodata) ||
      nodata.some(
        (v) => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= values.length
      ))
  ) {
    issues.push(`${path}.nodata must be integer indices inside [0, ${values.length})`);
    return null;
  }
  const unit = requireString(record, 'unit', issues, path);
  const basis = requireString(record, 'basis', issues, path);
  if (unit === null || basis === null) return null;
  if (dimensionOf(unit) === null) {
    issues.push(
      `${path}.unit ${JSON.stringify(unit)} is not a known length/angle/dimensionless unit; it will be retained but cannot be normalized`
    );
  }
  return {
    kind,
    grid: { rows, cols, origin, pixelPitch },
    values: values as number[],
    nodata: (nodata as number[] | undefined) ?? [],
    unit,
    basis
  };
}

function parseOne(record: unknown, index: number): RawPayload {
  const issues: string[] = [];
  const path = `inputs[${index}]`;
  if (!isRecord(record)) {
    throw new FormatValidationError([`${path} must be an object`]);
  }
  const kind = record['kind'];
  if (typeof kind !== 'string' || !RAW_KINDS.includes(kind as RawKind)) {
    throw new FormatValidationError([
      `${path}.kind must be one of ${RAW_KINDS.join(', ')}`
    ]);
  }
  const rawKind = kind as RawKind;

  if (
    rawKind === 'wrapped_phase' ||
    rawKind === 'amplitude' ||
    rawKind === 'snr_score' ||
    rawKind === 'validity_mask'
  ) {
    const grid = parseGrid(record, rawKind, issues, path);
    if (issues.length) throw new FormatValidationError(issues);
    return grid!;
  }

  if (rawKind === 'wavelength') {
    const lambda = parseQuantity(record, 'lambda', issues, path);
    if (issues.length) throw new FormatValidationError(issues);
    return { kind: 'wavelength', lambda: lambda! };
  }

  if (rawKind === 'incidence_geometry') {
    const incidenceAngle = parseQuantity(record, 'incidenceAngle', issues, path);
    const sensitivityModel = requireString(record, 'sensitivityModel', issues, path);
    if (issues.length) throw new FormatValidationError(issues);
    return {
      kind: 'incidence_geometry',
      incidenceAngle: incidenceAngle!,
      sensitivityModel: sensitivityModel!
    };
  }

  if (rawKind === 'calibration_surface') {
    const plane = record['plane'];
    if (!isRecord(plane)) {
      issues.push(`${path}.plane must be {a,b,c}`);
      throw new FormatValidationError(issues);
    }
    const a = requireNumber(plane, 'a', issues, `${path}.plane`);
    const b = requireNumber(plane, 'b', issues, `${path}.plane`);
    const c = requireNumber(plane, 'c', issues, `${path}.plane`);
    const planeUnit = record['planeUnit'];
    if (!isRecord(planeUnit)) {
      issues.push(`${path}.planeUnit must be {slope, intercept}`);
    }
    const fitRms = parseQuantity(record, 'fitRms', issues, path);
    const frames = record['calibrationFrames'];
    if (!Array.isArray(frames) || frames.some((f) => typeof f !== 'string')) {
      issues.push(`${path}.calibrationFrames must be string[]`);
    }
    if (issues.length || !planeUnit) throw new FormatValidationError(issues);
    return {
      kind: 'calibration_surface',
      plane: { a: a!, b: b!, c: c! },
      planeUnit: {
        slope: String((planeUnit as Record<string, unknown>)['slope']),
        intercept: String((planeUnit as Record<string, unknown>)['intercept'])
      },
      fitRms: fitRms!,
      calibrationFrames: frames as string[]
    };
  }

  const edits = record['edits'];
  if (!Array.isArray(edits)) {
    throw new FormatValidationError([`${path}.edits must be an array`]);
  }
  const parsedEdits: CutEdit[] = [];
  edits.forEach((edit, editIndex) => {
    const editPath = `${path}.edits[${editIndex}]`;
    if (!isRecord(edit)) {
      issues.push(`${editPath} must be an object`);
      return;
    }
    const edgeId = requireString(edit, 'edgeId', issues, editPath);
    const action = edit['action'];
    if (action !== 'add' && action !== 'remove' && action !== 'force_offset') {
      issues.push(`${editPath}.action must be add|remove|force_offset`);
    }
    const reason = requireString(edit, 'reason', issues, editPath);
    const actor = edit['actor'];
    if (actor !== 'human' && actor !== 'algorithm') {
      issues.push(`${editPath}.actor must be human|algorithm`);
    }
    let integerOffsetCycles: number | undefined;
    if (edit['integerOffsetCycles'] !== undefined) {
      if (typeof edit['integerOffsetCycles'] !== 'number' || !Number.isInteger(edit['integerOffsetCycles'])) {
        issues.push(`${editPath}.integerOffsetCycles must be an integer`);
      } else {
        integerOffsetCycles = edit['integerOffsetCycles'];
      }
    }
    if (edgeId !== null && reason !== null && (action === 'add' || action === 'remove' || action === 'force_offset')) {
      parsedEdits.push({
        edgeId,
        action: action as CutEdit['action'],
        integerOffsetCycles,
        reason,
        actor: (actor === 'human' || actor === 'algorithm' ? actor : 'algorithm') as CutEdit['actor']
      });
    }
  });
  if (issues.length) throw new FormatValidationError(issues);
  return { kind: 'cut_edit_history', edits: parsedEdits };
}

export interface ParsedImport {
  projectId: string;
  payloads: RawPayload[];
}

/**
 * Parse a copyable import document. Format errors are reported precisely;
 * accepted payloads are returned untouched (original units/representation kept).
 */
export function parseImportDocument(document: unknown): ParsedImport {
  if (!isRecord(document)) {
    throw new FormatValidationError(['import document must be a JSON object']);
  }
  const projectId = typeof document['project'] === 'string' && document['project'].length > 0
    ? document['project']
    : 'project';
  const inputs = document['inputs'];
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new FormatValidationError(['inputs must be a non-empty array']);
  }
  const payloads = inputs.map((input, index) => parseOne(input, index));
  return { projectId, payloads };
}

export { parseOne as parseRawInput };
