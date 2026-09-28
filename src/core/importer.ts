import { buildBundle } from './synth.js';
import { FRAME_PIXEL } from '../shared/units.js';
import type { RawSourceBundle } from '../shared/model.js';

/**
 * 导入层：接受可复制的小型样例，明确报告格式错误。
 * 原始表示保留；无法转换的值留在原位置并附诊断，绝不丢弃。
 */
export interface ImportDiagnostic {
  level: 'error' | 'warning';
  path: string;
  code: string;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  bundle?: RawSourceBundle;
  errors: ImportDiagnostic[];
  warnings: ImportDiagnostic[];
}

interface RawImportShape {
  sourceId?: unknown;
  label?: unknown;
  rows?: unknown;
  cols?: unknown;
  wrappedPhase?: unknown;
  amplitude?: unknown;
  invalidMask?: unknown;
  snr?: unknown;
  wavelength?: Record<string, unknown>;
  geometry?: Record<string, unknown>;
  calibration?: Record<string, unknown>;
  createdAtVirtual?: unknown;
}

export function importBundle(raw: unknown): ImportResult {
  const errors: ImportDiagnostic[] = [];
  const warnings: ImportDiagnostic[] = [];

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: [{ level: 'error', path: '$', code: 'NOT_OBJECT', message: '导入根必须是对象' }], warnings };
  }
  const o = raw as RawImportShape;
  const requireString = (v: unknown, path: string): string | null => {
    if (typeof v !== 'string' || v.length === 0) {
      errors.push({ level: 'error', path, code: 'MISSING_STRING', message: `${path} 必须是非空字符串` });
      return null;
    }
    return v;
  };
  const requireInt = (v: unknown, path: string): number | null => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      errors.push({ level: 'error', path, code: 'BAD_INT', message: `${path} 必须是正整数` });
      return null;
    }
    return v;
  };

  const sourceId = requireString(o.sourceId, 'sourceId');
  const rows = requireInt(o.rows, 'rows');
  const cols = requireInt(o.cols, 'cols');
  if (errors.length) return { ok: false, errors, warnings };
  const n = (rows as number) * (cols as number);

  const parseNumArray = (v: unknown, path: string, allowNonFinite: boolean): number[] | null => {
    if (!Array.isArray(v) || v.length !== n) {
      errors.push({ level: 'error', path, code: 'LENGTH_MISMATCH', message: `${path} 必须是长度 ${n} 的数组` });
      return null;
    }
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const x = v[i];
      if (typeof x !== 'number') {
        errors.push({ level: 'error', path: `${path}[${i}]`, code: 'NOT_NUMBER', message: `${path}[${i}] 不是数字` });
        return null;
      }
      if (!Number.isFinite(x)) {
        if (allowNonFinite) {
          warnings.push({ level: 'warning', path: `${path}[${i}]`, code: 'NON_FINITE_KEPT', message: '非有限值保留在原位置并附诊断' });
          out[i] = x;
        } else {
          errors.push({ level: 'error', path: `${path}[${i}]`, code: 'NON_FINITE', message: '出现 NaN/Infinity' });
          return null;
        }
      } else out[i] = x;
    }
    return out;
  };
  const parseBoolArray = (v: unknown, path: string): boolean[] | null => {
    if (!Array.isArray(v) || v.length !== n) {
      errors.push({ level: 'error', path, code: 'LENGTH_MISMATCH', message: `${path} 必须是长度 ${n} 的布尔数组` });
      return null;
    }
    return v.map((x) => x === true);
  };

  const phase = parseNumArray(o.wrappedPhase, 'wrappedPhase', true);
  const amplitude = parseNumArray(o.amplitude ?? new Array(n).fill(1), 'amplitude', false);
  const mask = parseBoolArray(o.invalidMask ?? new Array(n).fill(false), 'invalidMask');
  const snr = parseNumArray(o.snr ?? new Array(n).fill(0.95), 'snr', false);
  if (errors.length || !phase || !amplitude || !mask || !snr) return { ok: false, errors, warnings };

  // 波长/几何/标定：缺字段给明确错误；单位未知给警告但保留原值
  const wl = o.wavelength ?? {};
  const geo = o.geometry ?? {};
  const cal = o.calibration ?? {};
  if (typeof wl.wavelengthId !== 'string') errors.push({ level: 'error', path: 'wavelength.wavelengthId', code: 'MISSING_STRING', message: '缺少 wavelengthId' });
  if (typeof wl.value !== 'number') errors.push({ level: 'error', path: 'wavelength.value', code: 'NOT_NUMBER', message: '波长值必须是数字' });
  if (typeof geo.geometryId !== 'string') errors.push({ level: 'error', path: 'geometry.geometryId', code: 'MISSING_STRING', message: '缺少 geometryId' });
  if (typeof cal.calibrationId !== 'string') errors.push({ level: 'error', path: 'calibration.calibrationId', code: 'MISSING_STRING', message: '缺少 calibrationId' });
  if (errors.length) return { ok: false, errors, warnings };

  const bundle = buildBundle({
    sourceId: sourceId as string,
    label: (typeof o.label === 'string' ? o.label : sourceId) as string,
    rows: rows as number,
    cols: cols as number,
    phase,
    amplitude,
    mask,
    snr,
    createdAtVirtual: typeof o.createdAtVirtual === 'number' ? o.createdAtVirtual : 0,
    wavelength: {
      wavelengthId: String(wl.wavelengthId),
      value: Number(wl.value),
      unit: (wl.unit as never) ?? 'nm',
      refractiveIndex: typeof wl.refractiveIndex === 'number' ? Number(wl.refractiveIndex) : 1,
      revisionNote: typeof wl.revisionNote === 'string' ? wl.revisionNote : '导入波长',
    },
    geometry: {
      geometryId: String(geo.geometryId),
      incidenceAngle: typeof geo.incidenceAngle === 'number' ? Number(geo.incidenceAngle) : 0,
      angleUnit: (geo.angleUnit as never) ?? 'deg',
      model: geo.model === 'tilted-illumination' ? 'tilted-illumination' : 'normal-incidence',
      sensitivityFactorMetersPerRad:
        typeof geo.sensitivityFactorMetersPerRad === 'number' ? Number(geo.sensitivityFactorMetersPerRad) : undefined,
    },
    calibration: {
      calibrationId: String(cal.calibrationId),
      pixelScaleMeters: typeof cal.pixelScaleMeters === 'number' ? Number(cal.pixelScaleMeters) : null,
      referenceHeightM: typeof cal.referenceHeightM === 'number' ? Number(cal.referenceHeightM) : 0,
      fitResidualM: typeof cal.fitResidualM === 'number' ? Number(cal.fitResidualM) : 0,
      note: typeof cal.note === 'string' ? cal.note : '导入标定',
    },
  });
  bundle.grid.frame = FRAME_PIXEL;
  return { ok: true, bundle, errors, warnings };
}
