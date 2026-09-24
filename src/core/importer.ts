import type {
  CoordBasis,
  CutEdit,
  InvalidMaskContent,
  WrappedPhaseContent,
  AmplitudeContent,
  QualityScoreContent,
  WavelengthContent,
  IncidenceGeometryContent,
  CalibrationPlaneContent,
  CutEditHistoryContent,
  EntityKind,
  Provenance,
} from '../shared/domain.js';

export interface ImportDiagnostic {
  code:
    | 'FORMAT_ERROR'
    | 'MISSING_FIELD'
    | 'SHAPE_MISMATCH'
    | 'BAD_VALUE'
    | 'UNIT_NOT_CONVERTIBLE'
    | 'PHASE_OUT_OF_RANGE'
    | 'DIM_MISMATCH';
  path: string;
  message: string;
  fatal: boolean;
}

export interface NewEntityInput {
  kind: EntityKind;
  lineage: string;
  parentVersion?: number;
  content: unknown;
  provenance: Provenance;
}

export interface ImportPlan {
  accepted: boolean;
  entities: NewEntityInput[];
  diagnostics: ImportDiagnostic[];
  envelopeMeta: {
    format: string;
    formatVersion: string;
    caseId?: string;
    label?: string;
    basis: CoordBasis;
    dim: { rows: number; cols: number };
    provided: EntityKind[];
  };
}

const DEFAULT_BASIS: CoordBasis = {
  origin: 'top-left',
  axes: ['col', 'row'],
  pixelPitchX: 1e-6,
  pixelPitchY: 1e-6,
  lengthUnit: 'm',
};

const LENGTH_TO_M: Record<string, number> = {
  m: 1,
  mm: 1e-3,
  um: 1e-6,
  'µm': 1e-6,
  nm: 1e-9,
};

const ANGLE_TO_RAD: Record<string, number> = {
  rad: 1,
  mrad: 1e-3,
  deg: Math.PI / 180,
};

type Row = Record<string, unknown>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return asNumber(v);
}

function checkLength(diag: ImportDiagnostic[], path: string, arr: unknown[], expected: number, name: string): void {
  if (arr.length !== expected) {
    diag.push({
      code: 'DIM_MISMATCH',
      path,
      message: `${name} 长度 ${arr.length} 与像素数 ${expected} 不一致`,
      fatal: true,
    });
  }
}

function readGridRows(rows: unknown, diag: ImportDiagnostic[], path: string): Row[] {
  if (!Array.isArray(rows)) {
    diag.push({ code: 'FORMAT_ERROR', path, message: 'rows 必须是数组', fatal: true });
    return [];
  }
  return rows.filter((r) => {
    if (!isRecord(r)) {
      diag.push({ code: 'FORMAT_ERROR', path, message: '每行必须是对象', fatal: true });
      return false;
    }
    return true;
  }) as Row[];
}

function requireDim(env: Record<string, unknown>, diag: ImportDiagnostic[]): { rows: number; cols: number } {
  const dim = env.dim;
  if (!isRecord(dim)) {
    diag.push({ code: 'MISSING_FIELD', path: 'dim', message: '缺少 dim: {rows, cols}', fatal: true });
    return { rows: 0, cols: 0 };
  }
  const rows = asNumber(dim.rows);
  const cols = asNumber(dim.cols);
  if (rows === null || cols === null || rows < 1 || cols < 1) {
    diag.push({ code: 'BAD_VALUE', path: 'dim', message: 'dim.rows / dim.cols 必须为正整数', fatal: true });
    return { rows: 0, cols: 0 };
  }
  return { rows: Math.trunc(rows), cols: Math.trunc(cols) };
}

export interface ParseOptions {
  lineagePrefix: string; // 例：case:lab1:
  parentVersions?: Partial<Record<EntityKind, number>>;
}

export function parseIfbEnvelope(rawText: string, opts: ParseOptions): ImportPlan {
  const diag: ImportDiagnostic[] = [];
  let env: Record<string, unknown>;
  try {
    env = JSON.parse(rawText) as Record<string, unknown>;
  } catch (err) {
    return {
      accepted: false,
      entities: [],
      diagnostics: [
        {
          code: 'FORMAT_ERROR',
          path: '$',
          message: `不是合法 JSON：${(err as Error).message}`,
          fatal: true,
        },
      ],
      envelopeMeta: {
        format: 'ifb',
        formatVersion: '?',
        basis: DEFAULT_BASIS,
        dim: { rows: 0, cols: 0 },
        provided: [],
      },
    };
  }

  if (!isRecord(env) || env.format !== 'ifb') {
    diag.push({ code: 'FORMAT_ERROR', path: 'format', message: 'format 必须为 "ifb"', fatal: true });
  }
  const formatVersion = typeof env.formatVersion === 'string' ? env.formatVersion : '1.0';
  if (formatVersion !== '1.0') {
    diag.push({ code: 'FORMAT_ERROR', path: 'formatVersion', message: `不支持的 ifb 版本 ${formatVersion}`, fatal: true });
  }

  const dim = requireDim(env, diag);
  const n = dim.rows * dim.cols;
  const basis = parseBasis(env.basis, diag);
  const rows = readGridRows(env.rows, diag, 'rows');
  const provided: EntityKind[] = [];
  const entities: NewEntityInput[] = [];
  const lineagePrefix = opts.lineagePrefix;
  const pv = opts.parentVersions ?? {};
  const prov = (kind: EntityKind): Provenance => ({
    directSources: [],
    ...(pv[kind] !== undefined ? { parentVersion: pv[kind] } : {}),
  });

  if (n > 0 && rows.length === dim.rows) {
    parsePhase(rows, dim, n, diag, entities, provided, lineagePrefix, prov);
    parseAmplitude(rows, dim, n, diag, entities, provided, lineagePrefix, prov);
    parseQuality(rows, dim, n, diag, entities, provided, lineagePrefix, prov);
    parseMask(rows, dim, n, diag, entities, provided, lineagePrefix, prov);
  }
  parseWavelength(env, diag, entities, provided, lineagePrefix, prov);
  parseGeometry(env, diag, entities, provided, lineagePrefix, prov);
  parseCalibration(env, basis, diag, entities, provided, lineagePrefix, prov);
  parseCuts(env, dim, diag, entities, provided, lineagePrefix, prov);

  const fatal = diag.some((d) => d.fatal);
  return {
    accepted: !fatal,
    entities,
    diagnostics: diag,
    envelopeMeta: {
      format: 'ifb',
      formatVersion,
      caseId: typeof env.caseId === 'string' ? env.caseId : undefined,
      label: typeof env.label === 'string' ? env.label : undefined,
      basis,
      dim,
      provided,
    },
  };
}
