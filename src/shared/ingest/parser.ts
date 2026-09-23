import type {
  CalibrationPlane,
  CutEdit,
  CutEditHistory,
  DomainQuantity,
  GridDatum,
  IlluminationGeometry,
  ImportDiagnostic,
  InvalidMaskFrame,
  SignalQualityFrame,
  Vec2,
  WavelengthSpec,
  WrappedPhaseFrame,
} from '../domain/types';
import { makeGrid } from '../algo/grid';

export class IngestFormatError extends Error {
  constructor(
    readonly diagnostics: ImportDiagnostic[]
  ) {
    super(diagnostics.map((d) => `${d.code} @ ${d.path}: ${d.message}`).join('; '));
    this.name = 'IngestFormatError';
  }
}

const PHASE_RANGE = '[-pi,pi)';

/**
 * 解析“携带原始表示”的领域量：
 * - 数字 => raw 为其文本，value 为数值；
 * - {value, unit} => 补 raw；
 * - {raw, unit} => 尝试解析，失败则 value=null + 诊断，值留在原位置；
 * 派生层负责单位换算，这里只保留原样。
 */
export function parseQuantity(
  input: unknown,
  path: string,
  expectedUnit: string,
  diags: ImportDiagnostic[]
): DomainQuantity {
  if (typeof input === 'number') {
    return { raw: String(input), value: input, unit: expectedUnit };
  }
  if (typeof input === 'string') {
    return { raw: input, value: numericPortion(input), unit: unitPortion(input, expectedUnit) };
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const raw = obj.raw !== undefined ? String(obj.raw) : obj.value !== undefined ? String(obj.value) : '';
    const unit = typeof obj.unit === 'string' ? obj.unit : expectedUnit;
    let value: number | null = typeof obj.value === 'number' ? obj.value : numericPortion(raw);
    const diagnostic =
      value === null
        ? undefined
        : typeof obj.value === 'string'
          ? undefined
          : undefined;
    if (value === null && raw.trim() !== '') {
      diags.push({
        code: 'unconverted-quantity',
        path,
        message: `value "${raw}" could not be converted to ${unit}; kept in place`,
        severity: 'warning',
      });
    }
    if (!raw && obj.value === undefined) {
      diags.push({ code: 'missing-quantity', path, message: 'quantity has neither raw nor value', severity: 'error' });
    }
    void diagnostic;
    return { raw, value, unit, diagnostic: value === null && raw.trim() !== '' ? 'unconverted' : undefined };
  }
  diags.push({ code: 'bad-quantity', path, message: 'expected number, string or {raw,value,unit}', severity: 'error' });
  return { raw: '', value: null, unit: expectedUnit };
}

function numericPortion(text: string): number | null {
  const m = text.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function unitPortion(text: string, fallback: string): string {
  const m = text.match(/[a-zA-Z°µμ]+(?:\/[a-zA-Z°µμ²2]+)?/);
  return m ? m[0] : fallback;
}

export function requireObject(input: unknown, path: string, diags: ImportDiagnostic[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    diags.push({ code: 'not-object', path, message: 'expected JSON object', severity: 'error' });
    return {};
  }
  return input as Record<string, unknown>;
}

export function parseGridDatum(obj: Record<string, unknown>, path: string, diags: ImportDiagnostic[]): GridDatum {
  const width = Number(obj.width);
  const height = Number(obj.height);
  if (!Number.isInteger(width) || width <= 0) {
    diags.push({ code: 'bad-grid', path: `${path}.width`, message: 'width must be positive integer', severity: 'error' });
  }
  if (!Number.isInteger(height) || height <= 0) {
    diags.push({ code: 'bad-grid', path: `${path}.height`, message: 'height must be positive integer', severity: 'error' });
  }
  const grid = makeGrid(width || 0, height || 0);
  if (obj.coordinateFrame && typeof obj.coordinateFrame !== 'string') {
    diags.push({ code: 'bad-grid', path: `${path}.coordinateFrame`, message: 'coordinateFrame must be string', severity: 'error' });
  }
  return grid;
}

function vec(input: unknown, path: string, unit: string, diags: ImportDiagnostic[]): Vec2 {
  const obj = requireObject(input, path, diags);
  return {
    x: parseQuantity(obj.x, `${path}.x`, unit, diags),
    y: parseQuantity(obj.y, `${path}.y`, unit, diags),
  };
}

function checkLength(
  values: unknown[],
  expected: number,
  path: string,
  diags: ImportDiagnostic[]
): void {
  if (values.length !== expected) {
    diags.push({
      code: 'length-mismatch',
      path,
      message: `expected ${expected} cells for the grid, got ${values.length}`,
      severity: 'error',
    });
  }
}

export function parseWrappedPhase(input: unknown, diags: ImportDiagnostic[]): WrappedPhaseFrame {
  const obj = requireObject(input, 'wrapped_phase', diags);
  const grid = parseGridDatum(obj, 'wrapped_phase.grid', diags);
  const arr = Array.isArray(obj.phase) ? obj.phase : [];
  if (!Array.isArray(obj.phase)) {
    diags.push({ code: 'missing-array', path: 'wrapped_phase.phase', message: 'phase must be an array', severity: 'error' });
  }
  checkLength(arr, grid.width * grid.height, 'wrapped_phase.phase', diags);
  const phase: (number | null)[] = [];
  const cellDiagnostics: WrappedPhaseFrame['cellDiagnostics'] = [];
  arr.forEach((cell, p) => {
    if (cell === null || cell === undefined) {
      phase.push(null);
      cellDiagnostics.push({ pixel: p, raw: String(cell), diagnostic: 'missing phase: left unknown, never guessed' });
      return;
    }
    const n = typeof cell === 'number' ? cell : Number(cell);
    if (!Number.isFinite(n)) {
      phase.push(null);
      cellDiagnostics.push({ pixel: p, raw: String(cell), diagnostic: 'non-numeric phase kept as unknown' });
      return;
    }
    if (n >= Math.PI || n < -Math.PI) {
      diags.push({
        code: 'out-of-range',
        path: `wrapped_phase.phase[${p}]`,
        message: `phase ${n} outside convention ${PHASE_RANGE}`,
        severity: 'error',
      });
    }
    phase.push(n);
  });
  return {
    grid,
    phase,
    phaseUnit: 'rad',
    rangeConvention: '[-pi,pi)',
    cellDiagnostics,
    sourceLabel: String(obj.sourceLabel ?? 'wrapped-phase-frame'),
  };
}

export function parseSignalQuality(input: unknown, diags: ImportDiagnostic[]): SignalQualityFrame {
  const obj = requireObject(input, 'signal_quality', diags);
  const grid = parseGridDatum(obj, 'signal_quality.grid', diags);
  const amp = Array.isArray(obj.amplitude) ? obj.amplitude : [];
  const snr = Array.isArray(obj.snrDb) ? obj.snrDb : [];
  if (!Array.isArray(obj.amplitude)) diags.push({ code: 'missing-array', path: 'signal_quality.amplitude', message: 'amplitude must be an array', severity: 'error' });
  if (!Array.isArray(obj.snrDb)) diags.push({ code: 'missing-array', path: 'signal_quality.snrDb', message: 'snrDb must be an array', severity: 'error' });
  checkLength(amp, grid.width * grid.height, 'signal_quality.amplitude', diags);
  checkLength(snr, grid.width * grid.height, 'signal_quality.snrDb', diags);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    grid,
    amplitude: amp.map(num),
    amplitudeUnit: String(obj.amplitudeUnit ?? 'a.u.'),
    snrDb: snr.map(num),
    snrUnit: 'dB',
    sourceLabel: String(obj.sourceLabel ?? 'signal-quality-frame'),
  };
}

export function parseInvalidMask(input: unknown, diags: ImportDiagnostic[]): InvalidMaskFrame {
  const obj = requireObject(input, 'invalid_mask', diags);
  const grid = parseGridDatum(obj, 'invalid_mask.grid', diags);
  const arr = Array.isArray(obj.invalid) ? obj.invalid : [];
  if (!Array.isArray(obj.invalid)) diags.push({ code: 'missing-array', path: 'invalid_mask.invalid', message: 'invalid must be an array', severity: 'error' });
  checkLength(arr, grid.width * grid.height, 'invalid_mask.invalid', diags);
  const invalid = arr.map((v) => v === true || v === 1);
  const reasons: InvalidMaskFrame['reasons'] = [];
  if (Array.isArray(obj.reasons)) {
    for (const r of obj.reasons as unknown[]) {
      const ro = requireObject(r, 'invalid_mask.reasons', diags);
      reasons.push({
        pixels: Array.isArray(ro.pixels) ? (ro.pixels as number[]).filter((x) => Number.isInteger(x)) : [],
        reason: String(ro.reason ?? 'unspecified'),
      });
    }
  }
  return { grid, invalid, reasons, sourceLabel: String(obj.sourceLabel ?? 'invalid-mask-frame') };
}

export function parseWavelength(input: unknown, diags: ImportDiagnostic[]): WavelengthSpec {
  const obj = requireObject(input, 'wavelength', diags);
  return {
    lambda: parseQuantity(obj.lambda, 'wavelength.lambda', 'nm', diags),
    medium: String(obj.medium ?? 'air'),
    note: String(obj.note ?? ''),
  };
}

export function parseGeometry(input: unknown, diags: ImportDiagnostic[]): IlluminationGeometry {
  const obj = requireObject(input, 'illumination_geometry', diags);
  const incidence = parseQuantity(obj.incidenceAngle, 'illumination_geometry.incidenceAngle', 'deg', diags);
  const observation = parseQuantity(obj.observationAngle, 'illumination_geometry.observationAngle', 'deg', diags);
  const iv = requireObject(obj.incidentVector, 'illumination_geometry.incidentVector', diags);
  const ov = requireObject(obj.observationVector, 'illumination_geometry.observationVector', diags);
  const asVec3 = (o: Record<string, unknown>, path: string) => {
    for (const axis of ['x', 'y', 'z']) {
      if (typeof o[axis] !== 'number') diags.push({ code: 'bad-vector', path: `${path}.${axis}`, message: `${axis} must be number`, severity: 'error' });
    }
    return { x: Number(o.x ?? 0), y: Number(o.y ?? 0), z: Number(o.z ?? 0) };
  };
  return {
    incidenceAngle: incidence,
    observationAngle: observation,
    incidentVector: asVec3(iv, 'illumination_geometry.incidentVector'),
    observationVector: asVec3(ov, 'illumination_geometry.observationVector'),
    coordinateFrame: String(obj.coordinateFrame ?? 'lab-right-handed-z-up'),
  };
}

export function parseCalibration(input: unknown, diags: ImportDiagnostic[]): CalibrationPlane {
  const obj = requireObject(input, 'calibration_plane', diags);
  const anchor = Array.isArray(obj.anchorPixels)
    ? (obj.anchorPixels as unknown[]).map(Number).filter((n) => Number.isInteger(n))
    : [];
  if (!Array.isArray(obj.anchorPixels)) diags.push({ code: 'missing-array', path: 'calibration_plane.anchorPixels', message: 'anchorPixels must be array', severity: 'error' });
  return {
    coordinateFrame: String(obj.coordinateFrame ?? 'lab-right-handed-z-up'),
    a: parseQuantity(obj.a, 'calibration_plane.a', '1', diags),
    b: parseQuantity(obj.b, 'calibration_plane.b', '1', diags),
    c: parseQuantity(obj.c, 'calibration_plane.c', 'm', diags),
    anchorPixels: anchor,
    referenceHeight: parseQuantity(obj.referenceHeight, 'calibration_plane.referenceHeight', 'm', diags),
    rmsResidual: parseQuantity(obj.rmsResidual, 'calibration_plane.rmsResidual', 'm', diags),
    sourceFrameLabel: String(obj.sourceFrameLabel ?? 'calibration-frame'),
  };
}

export function parseCutHistory(input: unknown, diags: ImportDiagnostic[]): CutEditHistory {
  const obj = requireObject(input, 'cut_edit_history', diags);
  const edits: CutEdit[] = [];
  if (obj.edits !== undefined && !Array.isArray(obj.edits)) {
    diags.push({ code: 'missing-array', path: 'cut_edit_history.edits', message: 'edits must be array', severity: 'error' });
  }
  for (const [i, rawEdit] of Array.isArray(obj.edits) ? obj.edits.entries() : []) {
    const e = requireObject(rawEdit, `cut_edit_history.edits[${i}]`, diags);
    const action = e.action === 'add' || e.action === 'remove' ? e.action : 'add';
    if (e.action !== 'add' && e.action !== 'remove') {
      diags.push({ code: 'bad-action', path: `cut_edit_history.edits[${i}].action`, message: "action must be 'add'|'remove'", severity: 'error' });
    }
    edits.push({
      editId: String(e.editId ?? `edit-${i}`),
      action,
      a: Number(e.a),
      b: Number(e.b),
      reason: String(e.reason ?? ''),
      author: String(e.author ?? 'lab-operator'),
    });
  }
  return { edits };
}

export { vec };
