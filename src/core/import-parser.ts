import type {
  CoordBasis,
  CutEdit,
  RawGrid,
  ScenarioCode,
  Unit,
} from './types.js';
import { ImportFormatError } from './errors.js';
import { normalizeQuantity } from './units.js';

type Json = Record<string, unknown>;

const SCENARIOS: ScenarioCode[] = [
  'PHASE_WRAP_BOUNDARY',
  'LOW_AMPLITUDE_HOLE',
  'MULTIPLE_CONNECTED_REGIONS',
  'UNCLOSED_CYCLE',
  'WAVELENGTH_VERSION_CHANGE',
  'INTEGER_AMBIGUITY',
  'LOCAL_LOCK_CONFLICT',
];

const UNITS: Unit[] = ['rad', 'degree', 'turn', 'nm', 'um', 'mm', 'm', 'unitless', 'count', 'dimensionless'];

function asObject(dto: unknown, path: string): Json {
  if (dto === null || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new ImportFormatError('E_NOT_OBJECT', 'expected an object', path);
  }
  return dto as Json;
}

function kindOf(dto: unknown): string {
  const o = asObject(dto, '$');
  if (typeof o.kind !== 'string') throw new ImportFormatError('E_MISSING_KIND', 'field "kind" is required');
  return o.kind;
}

function readDim(o: Json, name: string, path: string): number {
  const v = o[name];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ImportFormatError('E_BAD_DIMENSION', `"${name}" must be a positive integer`, path);
  }
  return v;
}

function readCells(o: Json, path: string, rows: number, cols: number, allowedUnits?: Unit[]): RawGrid {
  const raw = o.cells;
  if (!Array.isArray(raw)) throw new ImportFormatError('E_CELLS_MISSING', '"cells" must be an array', path);
  const flat: (string | number | null)[] = [];
  const matrix: unknown[] = [];
  if (raw.length > 0 && Array.isArray(raw[0])) {
    if (raw.length !== rows) {
      throw new ImportFormatError('E_CELLS_ROWS', `expected ${rows} rows, got ${raw.length}`, path);
    }
    for (let r = 0; r < raw.length; r++) {
      const row = raw[r];
      if (!Array.isArray(row) || row.length !== cols) {
        throw new ImportFormatError('E_CELLS_COLS', `row ${r} must have ${cols} columns`, `${path}.cells[${r}]`);
      }
      matrix.push(...row);
    }
  } else {
    if (raw.length !== rows * cols) {
      throw new ImportFormatError('E_CELLS_LEN', `expected ${rows * cols} cells, got ${raw.length}`, path);
    }
    matrix.push(...raw);
  }

  const cellDiagnostics: RawGrid['cellDiagnostics'] = [];
  const values: (number | null)[] = [];
  const unit = (o.unit as Unit) ?? 'unitless';
  if (allowedUnits && !allowedUnits.includes(unit)) {
    throw new ImportFormatError('E_BAD_UNIT', `unit "${unit}" not allowed; expected one of ${allowedUnits.join(', ')}`, `${path}.unit`);
  }
  matrix.forEach((cell, index) => {
    if (cell === null) {
      flat.push(null);
      values.push(null);
      return;
    }
    if (typeof cell !== 'number' && typeof cell !== 'string') {
      throw new ImportFormatError('E_BAD_CELL', 'cell must be number, string, or null', `${path}.cells#${index}`);
    }
    flat.push(cell);
    const q = normalizeQuantity(cell, unit);
    if (q.value === null) {
      values.push(null);
      cellDiagnostics.push({ index, raw: cell, diagnostic: q.diagnostic ?? 'unparseable cell' });
    } else {
      values.push(q.value);
    }
  });

  return { rows, cols, cells: values, rawCells: flat, cellDiagnostics };
}

function readCoordBasis(o: Json, path: string): CoordBasis {
  const cb = (o.coordBasis as Json) ?? {};
  const name = typeof cb.name === 'string' ? cb.name : 'pixel-grid';
  return {
    id: typeof cb.id === 'string' ? cb.id : `basis-${name}`,
    name,
    axes: [
      { name: 'row', unit: 'unitless' },
      { name: 'col', unit: 'unitless' },
    ],
    origin: { row: 0, col: 0 },
  };
}

function readTags(o: Json): ScenarioCode[] {
  const tags = o.scenarioTags;
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !SCENARIOS.includes(t as ScenarioCode))) {
    throw new ImportFormatError('E_BAD_TAGS', `scenarioTags must be subset of ${SCENARIOS.join(', ')}`);
  }
  return tags as ScenarioCode[];
}

function readQuantityField(o: Json, name: string, path: string, allowed: Unit[]) {
  const q = o[name];
  if (q === null || typeof q !== 'object') {
    throw new ImportFormatError('E_MISSING_QUANTITY', `"${name}" is required`, path);
  }
  const qo = q as Json;
  const unit = qo.unit as Unit;
  if (!UNITS.includes(unit)) throw new ImportFormatError('E_BAD_UNIT', `unknown unit "${String(unit)}"`, `${path}.${name}.unit`);
  if (!allowed.includes(unit)) throw new ImportFormatError('E_BAD_UNIT', `unit "${unit}" not allowed here`, `${path}.${name}.unit`);
  if (qo.raw === undefined && qo.value === undefined) {
    throw new ImportFormatError('E_EMPTY_QUANTITY', `"${name}.raw/value" is required`, `${path}.${name}`);
  }
  const raw = (qo.raw ?? qo.value) as string | number;
  return normalizeQuantity(raw, unit);
}

export interface ParsedInput {
  kind:
    | 'wrappedPhaseFrame'
    | 'amplitudeFrame'
    | 'invalidMaskFrame'
    | 'wavelengthSpec'
    | 'illuminationGeometry'
    | 'calibrationPlane'
    | 'cutEditHistory';
  draft: Record<string, unknown>;
  cellDiagnosticCount: number;
}

export function parseImport(dto: unknown): ParsedInput {
  const kind = kindOf(dto);
  const o = asObject(dto, '$');
  switch (kind) {
    case 'wrappedPhaseFrame': {
      const rows = readDim(o, 'rows', '$.rows');
      const cols = readDim(o, 'cols', '$.cols');
      const grid = readCells(o, '$', rows, cols, ['rad', 'degree', 'turn']);
      return {
        kind,
        cellDiagnosticCount: grid.cellDiagnostics.length,
        draft: {
          coordBasis: readCoordBasis(o, '$.coordBasis'),
          phase: grid,
          wrappedRange: { min: -Math.PI, max: Math.PI, unit: 'rad' as Unit },
          scenarioTags: readTags(o),
        },
      };
    }
    case 'amplitudeFrame': {
      const rows = readDim(o, 'rows', '$.rows');
      const cols = readDim(o, 'cols', '$.cols');
      const ampSrc = asObject(o.amplitude ?? { unit: o.unit ?? 'unitless', cells: o.cells }, '$.amplitude');
      const amp = readCells(ampSrc, '$.amplitude', rows, cols, ['unitless', 'dimensionless']);
      const snrSrc = asObject(o.snrScore, '$.snrScore');
      const snr = readCells({ ...snrSrc, unit: 'unitless' }, '$.snrScore', rows, cols, ['unitless', 'dimensionless']);
      const threshold = readQuantityField(o, 'snrThreshold', '$', ['unitless', 'dimensionless']);
      return {
        kind,
        cellDiagnosticCount: amp.cellDiagnostics.length + snr.cellDiagnostics.length,
        draft: {
          coordBasis: readCoordBasis(o, '$.coordBasis'),
          amplitude: amp,
          snrScore: snr,
          snrThreshold: threshold,
          scenarioTags: readTags(o),
        },
      };
    }
    case 'invalidMaskFrame': {
      const rows = readDim(o, 'rows', '$.rows');
      const cols = readDim(o, 'cols', '$.cols');
      const raw = o.cells;
      if (!Array.isArray(raw)) throw new ImportFormatError('E_CELLS_MISSING', '"cells" must be an array');
      const flat: (string | number | null)[] = [];
      const vals: (number | null)[] = [];
      const diags: RawGrid['cellDiagnostics'] = [];
      const matrix: unknown[] = raw.length > 0 && Array.isArray(raw[0]) ? raw.flat() : raw;
      if (matrix.length !== rows * cols) {
        throw new ImportFormatError('E_CELLS_LEN', `expected ${rows * cols} cells, got ${matrix.length}`);
      }
      matrix.forEach((cell, index) => {
        if (cell === null || cell === 0 || cell === false) {
          flat.push(cell as null | 0 | false);
          vals.push(0);
        } else if (cell === 1 || cell === true) {
          flat.push(cell as 1 | true);
          vals.push(1);
        } else if (typeof cell === 'string' && (cell === 'x' || cell === 'X' || cell === '#')) {
          flat.push(cell);
          vals.push(1);
        } else {
          diags.push({ index, raw: cell as string | number, diagnostic: 'mask cell must be 0/1, true/false, "x", or null' });
          flat.push(typeof cell === 'number' || typeof cell === 'string' ? cell : null);
          vals.push(null);
        }
      });
      return {
        kind,
        cellDiagnosticCount: diags.length,
        draft: {
          coordBasis: readCoordBasis(o, '$.coordBasis'),
          invalid: { rows, cols, cells: vals, rawCells: flat, cellDiagnostics: diags },
          scenarioTags: readTags(o),
        },
      };
    }
    case 'wavelengthSpec': {
      const wavelength = readQuantityField(o, 'wavelength', '$', ['nm', 'um', 'mm', 'm']);
      return {
        kind,
        cellDiagnosticCount: wavelength.value === null ? 1 : 0,
        draft: { wavelength, note: typeof o.note === 'string' ? o.note : undefined },
      };
    }
    case 'illuminationGeometry': {
      const incidenceAngle = readQuantityField(o, 'incidenceAngle', '$', ['rad', 'degree', 'turn']);
      const setups = ['interferometer-normal', 'fringe-projection', 'custom'];
      const setup = typeof o.setup === 'string' ? o.setup : 'interferometer-normal';
      if (!setups.includes(setup)) throw new ImportFormatError('E_BAD_SETUP', `setup must be one of ${setups.join(', ')}`);
      let azimuth;
      if (o.azimuth !== undefined) azimuth = readQuantityField(o, 'azimuth', '$', ['rad', 'degree', 'turn']);
      return {
        kind,
        cellDiagnosticCount: (incidenceAngle.value === null ? 1 : 0) + (azimuth?.value === null ? 1 : 0),
        draft: { incidenceAngle, azimuth, setup: setup as CutEdit['kind'] extends never ? never : string },
      };
    }
    case 'calibrationPlane': {
      const rows = readDim(o, 'rows', '$.rows');
      const cols = readDim(o, 'cols', '$.cols');
      const src = asObject(o.surfaceHeight, '$.surfaceHeight');
      const height = readCells(src, '$.surfaceHeight', rows, cols, ['nm', 'um', 'mm', 'm']);
      return {
        kind,
        cellDiagnosticCount: height.cellDiagnostics.length,
        draft: {
          coordBasis: readCoordBasis(o, '$.coordBasis'),
          surfaceHeight: height,
          heightUnit: src.unit as Unit,
          datum: typeof o.datum === 'string' ? o.datum : throwDatum(),
        },
      };
    }
    case 'cutEditHistory': {
      const editsSrc = o.edits ?? [];
      if (!Array.isArray(editsSrc)) throw new ImportFormatError('E_BAD_EDITS', '"edits" must be an array');
      const edits: CutEdit[] = [];
      editsSrc.forEach((e, i) => {
        const eo = asObject(e, `$.edits[${i}]`);
        const kinds = ['add-cut', 'remove-cut', 'set-jump'];
        if (typeof eo.kind !== 'string' || !kinds.includes(eo.kind)) {
          throw new ImportFormatError('E_BAD_EDIT_KIND', `kind must be one of ${kinds.join(', ')}`, `$.edits[${i}]`);
        }
        edits.push({
          editId: typeof eo.editId === 'string' ? eo.editId : `imp-${i}`,
          atVirtual: typeof eo.atVirtual === 'number' ? eo.atVirtual : 0,
          kind: eo.kind as CutEdit['kind'],
          a: asCoord(eo.a, `$.edits[${i}].a`),
          b: asCoord(eo.b, `$.edits[${i}].b`),
          jump: typeof eo.jump === 'number' ? eo.jump : undefined,
          reason: typeof eo.reason === 'string' ? eo.reason : 'imported baseline',
          operator: typeof eo.operator === 'string' ? eo.operator : 'lab-import',
        });
      });
      return { kind, cellDiagnosticCount: 0, draft: { edits } };
    }
    default:
      throw new ImportFormatError('E_UNKNOWN_KIND', `unknown entity kind "${kind}"`);
  }
}

function asCoord(v: unknown, path: string): { row: number; col: number } {
  const o = asObject(v, path);
  if (typeof o.row !== 'number' || typeof o.col !== 'number') {
    throw new ImportFormatError('E_BAD_COORD', 'coord requires numeric row/col', path);
  }
  return { row: o.row, col: o.col };
}

function throwDatum(): string {
  throw new ImportFormatError('E_DATUM_REQUIRED', 'calibrationPlane requires a string "datum" (坐标基准)');
}
