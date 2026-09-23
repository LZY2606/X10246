import type { GridBasis, InputKind, InputPayload } from '../shared/types.js';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  path: string;
  /** 不可转换值留在原位置时记录的数组下标 */
  index?: number;
  message: string;
  /** 诊断发生时的原始值（不丢弃） */
  raw?: unknown;
}

export interface ImportResult {
  kind: InputKind;
  /** 可接受（无 error）时给出载荷；warning 不阻止导入 */
  accepted: boolean;
  payload?: InputPayload;
  diagnostics: Diagnostic[];
  /** 提交的原始文本，原样保留，不做就地改写 */
  rawText: string;
}

const UNIT_TO_RAD: Record<string, number> = { rad: 1, degree: Math.PI / 180 };
const LENGTH_TO_NM: Record<string, number> = {
  nm: 1,
  um: 1000,
  mm: 1_000_000,
  m: 1_000_000_000,
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function requireObject(raw: unknown, d: Diagnostic[]): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  d.push({ code: 'NOT_OBJECT', severity: 'error', path: '$', message: '输入必须是 JSON 对象' });
  return null;
}

function parseBasis(obj: Record<string, unknown>, d: Diagnostic[]): GridBasis | null {
  const rows = obj.rows;
  const cols = obj.cols;
  if (!isFiniteNumber(rows) || rows <= 0 || !Number.isInteger(rows)) {
    d.push({ code: 'BAD_ROWS', severity: 'error', path: 'rows', raw: rows, message: 'rows 必须是正整数' });
  }
  if (!isFiniteNumber(cols) || cols <= 0 || !Number.isInteger(cols)) {
    d.push({ code: 'BAD_COLS', severity: 'error', path: 'cols', raw: cols, message: 'cols 必须是正整数' });
  }
  if (d.some((x) => x.severity === 'error')) return null;
  const basis: GridBasis = {
    rows: rows as number,
    cols: cols as number,
    coordinateBasis: typeof obj.coordinateBasis === 'string' ? obj.coordinateBasis : 'pixel',
    origin: { r: 0, c: 0 },
    pixelPitch: (() => {
      const pp = obj.pixelPitch as Record<string, unknown> | undefined;
      if (pp && isFiniteNumber(pp.dr) && isFiniteNumber(pp.dc)) {
        return { dr: pp.dr as number, dc: pp.dc as number, unit: (typeof pp.unit === 'string' ? pp.unit : 'pixel') as 'pixel' };
      }
      return null;
    })(),
  };
  return basis;
}

function numericSeries(
  raw: unknown,
  expectLen: number,
  path: string,
  d: Diagnostic[],
  rangeCheck?: (v: number) => string | null,
): number[] | null {
  if (!Array.isArray(raw)) {
    d.push({ code: 'NOT_ARRAY', severity: 'error', path, raw, message: `${path} 必须是数组` });
    return null;
  }
  if (raw.length !== expectLen) {
    d.push({
      code: 'LENGTH_MISMATCH',
      severity: 'error',
      path,
      message: `${path} 长度 ${raw.length} 与网格 ${expectLen} 不一致`,
    });
    return null;
  }
  const out: number[] = new Array(expectLen);
  for (let i = 0; i < expectLen; i++) {
    const v = raw[i];
    if (!isFiniteNumber(v)) {
      // 无法转换的值留在原位置（NaN 占位），原始值进诊断，绝不丢弃
      out[i] = Number.NaN;
      d.push({ code: 'NON_NUMERIC', severity: 'error', path, index: i, raw: v, message: `${path}[${i}] 不是有限数值，保留在原位置` });
      continue;
    }
    const rangeMsg = rangeCheck?.(v);
    if (rangeMsg) {
      out[i] = v;
      d.push({ code: 'OUT_OF_RANGE', severity: 'warning', path, index: i, raw: v, message: rangeMsg });
    } else {
      out[i] = v;
    }
  }
  return out;
}

function boolSeries(raw: unknown, expectLen: number, path: string, d: Diagnostic[]): boolean[] | null {
  if (!Array.isArray(raw)) {
    d.push({ code: 'NOT_ARRAY', severity: 'error', path, raw, message: `${path} 必须是布尔数组` });
    return null;
  }
  if (raw.length !== expectLen) {
    d.push({ code: 'LENGTH_MISMATCH', severity: 'error', path, message: `${path} 长度不匹配` });
    return null;
  }
  return raw.map((v) => v === true);
}

function unitSpec(raw: unknown, path: string, d: Diagnostic[], allowed?: string[]) {
  if (!raw || typeof raw !== 'object') {
    d.push({ code: 'NO_UNIT', severity: 'error', path, raw, message: `${path} 必须带单位` });
    return null;
  }
  const u = raw as Record<string, unknown>;
  const unit = u.unit;
  if (typeof unit !== 'string') {
    d.push({ code: 'BAD_UNIT', severity: 'error', path: `${path}.unit`, raw: unit, message: '单位 unit 缺失' });
    return null;
  }
  if (allowed && !allowed.includes(unit)) {
    d.push({
      code: 'UNCONVERTIBLE_UNIT',
      severity: 'error',
      path: `${path}.unit`,
      raw: unit,
      message: `单位 ${unit} 无法转换（允许 ${allowed.join(' / ')}）；值保留在原位置并附诊断`,
    });
    return null;
  }
  return {
    unit,
    coordinateBasis: typeof u.coordinateBasis === 'string' ? u.coordinateBasis : null,
    note: typeof u.note === 'string' ? u.note : null,
  };
}

/**
 * 导入单一领域实体。
 * 接受可复制的小型样例 JSON；格式错误以结构化诊断返回，不抛异常。
 */
export function importInput(kind: InputKind, rawText: string): ImportResult {
  const d: Diagnostic[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    return {
      kind,
      accepted: false,
      diagnostics: [{ code: 'BAD_JSON', severity: 'error', path: '$', message: `JSON 解析失败: ${(err as Error).message}` }],
      rawText,
    };
  }
  const obj = requireObject(raw, d);
  let payload: InputPayload | undefined;

  if (obj) {
    switch (kind) {
      case 'wrapped_phase': {
        const basis = parseBasis(obj, d);
        const phaseUnit = unitSpec(obj.phaseUnit, 'phaseUnit', d, ['rad', 'degree']);
        if (basis && phaseUnit) {
          const pixels = numericSeries(obj.pixels, basis.rows * basis.cols, 'pixels', d, (v) =>
            v > Math.PI || v <= -Math.PI ? `包裹相位 ${v.toFixed(3)} 超出约定 (-π, π]` : null,
          );
          if (pixels) {
            payload = {
              kind,
              basis,
              pixels,
              rangeConvention: typeof obj.rangeConvention === 'string' ? obj.rangeConvention : '(-pi, pi]',
              phaseUnit,
            };
          }
        }
        break;
      }
      case 'amplitude': {
        const basis = parseBasis(obj, d);
        const amplitudeUnit = unitSpec(obj.amplitudeUnit, 'amplitudeUnit', d);
        if (basis && amplitudeUnit) {
          const pixels = numericSeries(obj.pixels, basis.rows * basis.cols, 'pixels', d, (v) =>
            v < 0 ? `振幅为负 ${v}，保留原值` : null,
          );
          if (pixels) payload = { kind, basis, pixels, amplitudeUnit };
        }
        break;
      }
      case 'snr_score': {
        const basis = parseBasis(obj, d);
        const snrUnit = unitSpec(obj.snrUnit, 'snrUnit', d);
        if (basis && snrUnit) {
          const pixels = numericSeries(obj.pixels, basis.rows * basis.cols, 'pixels', d);
          if (pixels) payload = { kind, basis, pixels, snrUnit };
        }
        break;
      }
      case 'invalid_mask': {
        const basis = parseBasis(obj, d);
        const maskUnit = unitSpec(obj.maskUnit, 'maskUnit', d);
        if (basis && maskUnit) {
          const flags = boolSeries(obj.flags, basis.rows * basis.cols, 'flags', d);
          if (flags) payload = { kind, basis, flags, maskUnit };
        }
        break;
      }
      case 'wavelength': {
        const wavelengthUnit = unitSpec(obj.wavelengthUnit, 'wavelengthUnit', d, ['nm', 'um', 'mm', 'm']);
        const value = obj.value;
        if (!isFiniteNumber(value) || value <= 0) {
          d.push({ code: 'BAD_VALUE', severity: 'error', path: 'value', raw: value, message: '波长必须是正数' });
        }
        if (wavelengthUnit && isFiniteNumber(value) && value > 0) {
          payload = {
            kind,
            value,
            wavelengthUnit,
            medium: typeof obj.medium === 'string' ? obj.medium : 'vacuum',
          };
        }
        break;
      }
      case 'illumination_geometry': {
        const vec = (name: string): [number, number, number] | null => {
          const v = obj[name];
          if (!Array.isArray(v) || v.length !== 3 || !v.every(isFiniteNumber)) {
            d.push({ code: 'BAD_VECTOR', severity: 'error', path: name, raw: v, message: `${name} 必须是长度 3 的数值向量` });
            return null;
          }
          return [v[0], v[1], v[2]];
        };
        const s = vec('sourceVector');
        const o = vec('observationVector');
        const n = vec('surfaceNormal');
        if (s && o && n) {
          payload = {
            kind,
            sourceVector: s,
            observationVector: o,
            surfaceNormal: n,
            angleUnit: { unit: 'unitless', note: '方向以单位向量给出' },
            coordinateBasis: typeof obj.coordinateBasis === 'string' ? obj.coordinateBasis : 'lab_mm',
          };
        }
        break;
      }
      case 'calibration_plane': {
        const keys = ['a', 'b', 'c'] as const;
        for (const k of keys) {
          if (!isFiniteNumber(obj[k])) d.push({ code: 'BAD_COEFF', severity: 'error', path: k, raw: obj[k], message: `标定面系数 ${k} 必须是数值` });
        }
        if (keys.every((k) => isFiniteNumber(obj[k]))) {
          payload = {
            kind,
            a: obj.a as number,
            b: obj.b as number,
            c: obj.c as number,
            coefficientUnits: {
              slope: 'unitless',
              offset: 'nm',
              xy: 'pixel',
              z: 'nm',
            },
            coordinateBasis: typeof obj.coordinateBasis === 'string' ? obj.coordinateBasis : 'pixel',
          };
        }
        break;
      }
      case 'cut_edit_history': {
        const basis = parseBasis(obj, d);
        if (!Array.isArray(obj.edits)) {
          d.push({ code: 'NOT_ARRAY', severity: 'error', path: 'edits', message: 'edits 必须是数组' });
        }
        if (basis && Array.isArray(obj.edits)) {
          const edits = [];
          for (let i = 0; i < obj.edits.length; i++) {
            const e = obj.edits[i] as Record<string, unknown>;
            const edge = e.edge;
            if (
              !e ||
              typeof e.editId !== 'string' ||
              (e.action !== 'add_cut' && e.action !== 'remove_cut') ||
              !Array.isArray(edge) ||
              edge.length !== 2
            ) {
              d.push({ code: 'BAD_EDIT', severity: 'error', path: `edits[${i}]`, raw: e, message: '切口编辑字段不完整' });
            } else {
              edits.push({
                editId: e.editId,
                atTime: typeof e.atTime === 'string' ? e.atTime : '',
                actor: e.actor === 'human' ? 'human' : 'algorithm',
                action: e.action,
                edge: edge as [{ r: number; c: number }, { r: number; c: number }],
                reason: typeof e.reason === 'string' ? e.reason : '',
              });
            }
          }
          if (!d.some((x) => x.severity === 'error')) payload = { kind, basis, edits };
        }
        break;
      }
    }
  }

  const accepted = !d.some((x) => x.severity === 'error');
  return { kind, accepted: accepted && !!payload, payload: accepted ? payload : undefined, diagnostics: d, rawText };
}

export const UNIT_CONVERSIONS = { UNIT_TO_RAD, LENGTH_TO_NM };
