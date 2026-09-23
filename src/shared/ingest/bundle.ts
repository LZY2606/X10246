import type { ImportDiagnostic, RawSlot } from '../domain/types';
import { IngestFormatError } from './parser';
export { IngestFormatError };
import {
  parseCalibration,
  parseCutHistory,
  parseGeometry,
  parseInvalidMask,
  parseSignalQuality,
  parseWavelength,
  parseWrappedPhase,
} from './parser';

/**
 * 可复制的小型样例包。grid 尺寸由 wrapped_phase 声明，其余数组必须逐像素等长；
 * 任一字段缺失 / 格式错误都以明确诊断拒绝，绝不静默修补。
 */
export interface RawBundle {
  caseId: string;
  label: string;
  wrapped_phase: unknown;
  signal_quality: unknown;
  invalid_mask: unknown;
  wavelength: unknown;
  illumination_geometry: unknown;
  calibration_plane: unknown;
  cut_edit_history: unknown;
}

export const REQUIRED_SLOTS: RawSlot[] = [
  'wrapped_phase',
  'signal_quality',
  'invalid_mask',
  'wavelength',
  'illumination_geometry',
  'calibration_plane',
  'cut_edit_history',
];

export function validateBundle(input: unknown): {
  diagnostics: ImportDiagnostic[];
  bundle: RawBundle | null;
} {
  const diagnostics: ImportDiagnostic[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      diagnostics: [
        { code: 'not-object', path: '$', message: 'case bundle must be a JSON object', severity: 'error' },
      ],
      bundle: null,
    };
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.caseId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,40}$/.test(obj.caseId)) {
    diagnostics.push({
      code: 'bad-case-id',
      path: '$.caseId',
      message: 'caseId must match /^[a-z0-9][a-z0-9-]{2,40}$/',
      severity: 'error',
    });
  }
  for (const slot of REQUIRED_SLOTS) {
    if (obj[slot] === undefined) {
      diagnostics.push({ code: 'missing-slot', path: `$.${slot}`, message: `required slot ${slot} is absent`, severity: 'error' });
    }
  }

  const grid = obj.wrapped_phase && typeof obj.wrapped_phase === 'object'
    ? (obj.wrapped_phase as Record<string, unknown>)
    : null;
  const width = Number(grid?.width);
  const height = Number(grid?.height);
  if (Number.isInteger(width) && Number.isInteger(height)) {
    for (const [name, field] of [
      ['signal_quality', 'amplitude'],
      ['signal_quality', 'snrDb'],
      ['invalid_mask', 'invalid'],
    ] as const) {
      const section = obj[name] && typeof obj[name] === 'object' ? (obj[name] as Record<string, unknown>) : null;
      const arr = section?.[field];
      if (Array.isArray(arr) && arr.length !== width * height) {
        diagnostics.push({
          code: 'length-mismatch',
          path: `$.${name}.${field}`,
          message: `expected ${width * height} cells, got ${arr.length}`,
          severity: 'error',
        });
      }
    }
  }

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  if (hasErrors) return { diagnostics, bundle: null };
  return { diagnostics, bundle: obj as unknown as RawBundle };
}

export interface ParsedRawSet {
  wrappedPhase: ReturnType<typeof parseWrappedPhase>;
  signalQuality: ReturnType<typeof parseSignalQuality>;
  invalidMask: ReturnType<typeof parseInvalidMask>;
  wavelength: ReturnType<typeof parseWavelength>;
  geometry: ReturnType<typeof parseGeometry>;
  calibration: ReturnType<typeof parseCalibration>;
  cutHistory: ReturnType<typeof parseCutHistory>;
}

/** 完整解析；任何 error 级诊断抛 IngestFormatError（warning 附在实体诊断里）。 */
export function parseBundle(bundle: RawBundle): {
  parsed: ParsedRawSet;
  warnings: ImportDiagnostic[];
} {
  const diags: ImportDiagnostic[] = [];
  const parsed: ParsedRawSet = {
    wrappedPhase: parseWrappedPhase(bundle.wrapped_phase, diags),
    signalQuality: parseSignalQuality(bundle.signal_quality, diags),
    invalidMask: parseInvalidMask(bundle.invalid_mask, diags),
    wavelength: parseWavelength(bundle.wavelength, diags),
    geometry: parseGeometry(bundle.illumination_geometry, diags),
    calibration: parseCalibration(bundle.calibration_plane, diags),
    cutHistory: parseCutHistory(bundle.cut_edit_history, diags),
  };
  const errors = diags.filter((d) => d.severity === 'error');
  if (errors.length) throw new IngestFormatError(diags);
  return { parsed, warnings: diags.filter((d) => d.severity === 'warning') };
}
