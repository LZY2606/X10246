import type {
  Grid2D, CoordBasis, RawCell, RawCellScalar,
  RawPhaseFrame, QualityFrame, ValidityMask, WavelengthSpec,
  IncidenceGeometry, CalibrationSurface, Cid, LineageId
} from './types';
import { contentId } from './hashing';
import { convertLengthToNm } from './units';

export class ImportFormatError extends Error {
  path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ImportFormatError';
    this.path = path;
  }
}

/**
 * 导入包——直接采用领域词汇：
 * { phasePixels, amplitude, snr, invalidMask, wavelength, incidenceGeometry, calibration }
 * 所有网格量以一维数组（行主序）提交；原始表示保留在 RawCell.raw。
 */
export interface ImportBundle {
  width: number;
  height: number;
  coordBasis?: Partial<CoordBasis>;
  /** 包裹相位（rad），元素可为 number 或字符串（含 'N/A' 等无法解析值） */
  phasePixels: (number | string)[];
  amplitude: (number | string)[];
  amplitudeUnits?: string;
  snr?: (number | string)[];
  snrUnits?: string;
  invalidMask?: boolean[];
  wavelength: { raw?: number | string; value?: number; units?: string };
  incidenceGeometry: {
    angle: number | string;
    angleUnits?: string;
    projectionAxis?: [number, number, number];
  };
  calibration?: {
    referencePhase: (number | string)[];
    planeFit?: CalibrationSurface['planeFit'];
  };
}

function requireObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ImportFormatError(path, '必须是对象');
  }
  return v as Record<string, unknown>;
}

function natural(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new ImportFormatError(path, '必须是正整数');
  }
  return v;
}

function grid(bundle: Record<string, unknown>): Grid2D {
  const width = natural(bundle.width, 'width');
  const height = natural(bundle.height, 'height');
  const cb = (bundle.coordBasis ?? {}) as Record<string, unknown>;
  return {
    width,
    height,
    coordBasis: {
      origin: Array.isArray(cb.origin) && cb.origin.length === 2
        ? [Number(cb.origin[0]), Number(cb.origin[1])]
        : [0, 0],
      dx: typeof cb.dx === 'number' ? cb.dx : 1,
      dy: typeof cb.dy === 'number' ? cb.dy : 1,
      units: typeof cb.units === 'string' ? cb.units : 'pixel',
      crs: typeof cb.crs === 'string' ? cb.crs : 'sensor-local-right-down'
    }
  };
}

function cells(values: unknown, n: number, path: string, parse: (s: string) => number | null): RawCell[] {
  if (!Array.isArray(values)) throw new ImportFormatError(path, '必须是数组（行主序，长度 = 宽×高）');
  if (values.length !== n) throw new ImportFormatError(path, `长度 ${values.length} 与宽×高 ${n} 不一致`);
  return values.map((v, i) => {
    const raw = typeof v === 'string' ? v : String(v);
    const num = typeof v === 'number' && Number.isFinite(v) ? v
      : typeof v === 'string' ? parse(v.trim())
      : null;
    return {
      x: i % (n === 0 ? 1 : Math.sqrt(n)) | 0,
      y: 0,
      raw,
      value: num,
      diagnostic: num === null && (typeof v !== 'number' || !Number.isFinite(v as number)) ? 'unparseable-value-kept-in-place' : null
    };
  });
}

/** 行主序下补全 x/y（上面的通用 cells 无法知道宽，这里覆盖） */
function withXY(rawCells: RawCell[], width: number): RawCell[] {
  return rawCells.map((c, i) => ({ ...c, x: i % width, y: Math.floor(i / width) }));
}

function numericToken(s: string): number | null {
  if (s === '' || s === 'N/A' || s === 'null' || s === 'NaN') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function angleToken(s: string): number | null {
  const m = /^(-?[\d.]+)(rad|deg)$/i.exec(s);
  if (m) return Number(m[1]);
  return numericToken(s);
}

type Draft = Omit<RawPhaseFrame, 'id' | 'lineageId' | 'version' | 'parentId' | 'createdAtEvent'>
  | Omit<QualityFrame, 'id' | 'lineageId' | 'version' | 'parentId' | 'createdAtEvent'>
  | Omit<ValidityMask, 'id' | 'lineageId' | 'version' | 'parentId' | 'createdAtEvent'>
  | Omit<WavelengthSpec, 'id' | 'lineageId' | 'version' | 'parentId' | 'createdAtEvent'>
  | Omit<IncidenceGeometry, 'id' | 'lineageId' | 'version' | 'parentId' | 'createdAtEvent'>
  | Omit<CalibrationSurface, 'id' | 'lineageId' | 'version' | 'parentId' | 'createdAtEvent'>;

export interface ImportedDrafts {
  phase: Extract<Draft, { kind: 'RawPhaseFrame' }>;
  quality: Extract<Draft, { kind: 'QualityFrame' }>;
  mask: Extract<Draft, { kind: 'ValidityMask' }>;
  wavelength: Extract<Draft, { kind: 'WavelengthSpec' }>;
  geometry: Extract<Draft, { kind: 'IncidenceGeometry' }>;
  calibration?: Extract<Draft, { kind: 'CalibrationSurface' }>;
}

export function importBundle(input: unknown): ImportedDrafts {
  const b = requireObject(input, 'bundle');
  const g = grid(b);
  const n = g.width * g.height;

  const phaseCells = withXY(cells(b.phasePixels, n, 'phasePixels', numericToken), g.width);
  const amplitude = withXY(cells(b.amplitude, n, 'amplitude', numericToken), g.width);
  const snr = b.snr === undefined
    ? Array.from({ length: n }, (_, i): RawCell => ({ x: i % g.width, y: Math.floor(i / g.width), raw: '', value: null, diagnostic: 'snr-not-provided-estimated-in-derived-layer' }))
    : withXY(cells(b.snr, n, 'snr', numericToken), g.width);

  const invalid = Array.isArray(b.invalidMask) ? b.invalidMask : Array(n).fill(false);
  if (!Array.isArray(b.invalidMask)) {
    // 缺省遮罩：解析失败的相位或振幅视为无效
  }
  if (!Array.isArray(invalid) || invalid.length !== n) {
    throw new ImportFormatError('invalidMask', `必须是长度 ${n} 的布尔数组`);
  }
  const invalidBool = (invalid as unknown[]).map((v, i) => {
    if (typeof v !== 'boolean') throw new ImportFormatError(`invalidMask[${i}]`, '必须是布尔值');
    return v;
  });
  const reason: (string | null)[] = invalidBool.map((inv, i) => {
    if (!inv) return null;
    if (phaseCells[i].value === null) return 'phase-unparseable';
    if (amplitude[i].value === null) return 'amplitude-unparseable';
    return 'masked-on-import';
  });

  if (typeof b.wavelength !== 'object' || b.wavelength === null) {
    throw new ImportFormatError('wavelength', '必须是对象 {value, units}');
  }
  const wl = b.wavelength as Record<string, unknown>;
  const wlRaw = wl.raw ?? wl.value;
  const wlUnits = typeof wl.units === 'string' ? wl.units : 'nm';
  const wlNum = typeof wlRaw === 'number' ? wlRaw : typeof wlRaw === 'string' ? numericToken(wlRaw) : null;
  let wavelengthScalar: RawCellScalar;
  if (wlNum === null) {
    wavelengthScalar = { raw: String(wlRaw ?? ''), value: null, units: wlUnits, diagnostic: 'wavelength-unparseable-kept-in-place' };
  } else {
    const conv = convertLengthToNm(wlNum, wlUnits);
    wavelengthScalar = { raw: String(wlRaw), value: conv.value, units: 'nm', diagnostic: conv.diagnostic };
  }

  if (typeof b.incidenceGeometry !== 'object' || b.incidenceGeometry === null) {
    throw new ImportFormatError('incidenceGeometry', '必须是对象');
  }
  const geo = b.incidenceGeometry as Record<string, unknown>;
  const angRaw = geo.angle;
  const angUnits = typeof geo.angleUnits === 'string' ? geo.angleUnits : 'rad';
  const angNum = typeof angRaw === 'number' ? angRaw : typeof angRaw === 'string' ? angleToken(String(angRaw)) : null;
  const axis = Array.isArray(geo.projectionAxis) && geo.projectionAxis.length === 3
    ? (geo.projectionAxis as unknown[]).map(Number) as [number, number, number]
    : [0, 0, 1];

  const drafts: ImportedDrafts = {
    phase: { kind: 'RawPhaseFrame', grid: g, units: 'rad', phaseRange: '(-pi, pi]', cells: phaseCells },
    quality: {
      kind: 'QualityFrame', grid: g,
      amplitude, amplitudeUnits: typeof b.amplitudeUnits === 'string' ? b.amplitudeUnits : 'counts',
      snr, snrUnits: typeof b.snrUnits === 'string' ? b.snrUnits : 'dB'
    },
    mask: { kind: 'ValidityMask', grid: g, invalid: invalidBool, reason },
    wavelength: { kind: 'WavelengthSpec', lambda: wavelengthScalar },
    geometry: {
      kind: 'IncidenceGeometry',
      incidenceAngle: {
        raw: String(angRaw ?? ''), value: angNum, units: angUnits,
        diagnostic: angNum === null ? 'angle-unparseable-kept-in-place' : null
      },
      angleConvention: 'angle-from-normal',
      sensitivityModel: 'fringe-projection',
      projectionAxis: axis
    }
  };

  if (b.calibration !== undefined) {
    const cal = requireObject(b.calibration, 'calibration');
    const ref = withXY(cells(cal.referencePhase, n, 'calibration.referencePhase', numericToken), g.width);
    drafts.calibration = {
      kind: 'CalibrationSurface', grid: g, referencePhase: ref, units: 'rad',
      planeFit: (cal.planeFit as CalibrationSurface['planeFit']) ?? null
    };
  }
  return drafts;
}

/** 逻辑谱系：同 kind + 网格/语义槽位在项目内沿用同一 lineageId */
export function lineageKey(kind: string, slot?: string): LineageId {
  return contentId('lin', { kind, slot: slot ?? kind }).replace(/^[a-z]+_/, 'lin_');
}

/** 对输入草稿计算其稳定内容身份（不含版本字段，版本字段由 store 赋予） */
export function draftContentId(kind: string, draft: unknown): Cid {
  return contentId(kind.toLowerCase().replace(/frame|spec|surface|geometry/i, '').slice(0, 6) || 'in', draft);
}
