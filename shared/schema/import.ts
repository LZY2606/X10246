import type {
  AmplitudeInput,
  CalibrationPlaneInput,
  CoordinateFrame,
  CutEditHistoryInput,
  IlluminationGeometryInput,
  InvalidMaskInput,
  WavelengthInput,
  WrappedPhaseInput
} from '../domain/types.js';
import { isKnownUnit } from './units.js';

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly path?: string
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportResult<T> {
  payload: T;
  diagnostics: string[];
}

function requireObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new ImportError(`期望对象，得到 ${Array.isArray(raw) ? '数组' : typeof raw}`, 'NOT_OBJECT', path);
  return raw as Record<string, unknown>;
}

function requireNumber(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw))
    throw new ImportError(`期望有限数值`, 'NOT_NUMBER', path);
  return raw;
}

function requireInt(raw: unknown, path: string): number {
  const n = requireNumber(raw, path);
  if (!Number.isInteger(n) || n <= 0) throw new ImportError(`期望正整数`, 'NOT_POSITIVE_INT', path);
  return n;
}

function readDims(o: Record<string, unknown>): { width: number; height: number } {
  return { width: requireInt(o.width, 'width'), height: requireInt(o.height, 'height') };
}

function readUnit(o: Record<string, unknown>, path: string) {
  const u = requireObject(o.unit ?? o, `${path}.unit`);
  const unit = { kind: String(u.kind ?? ''), symbol: String(u.symbol ?? '') };
  if (!isKnownUnit(unit))
    throw new ImportError(`未知单位 ${unit.kind}/${unit.symbol}`, 'UNKNOWN_UNIT', path);
  return unit;
}

/** 包裹相位导入：保留原始字符串表示；尺寸/范围严格校验 */
export function parseWrappedPhase(raw: unknown): ImportResult<WrappedPhaseInput> {
  const o = requireObject(raw, 'wrapped_phase');
  const { width, height } = readDims(o);
  const arr = o.values;
  if (!Array.isArray(arr) || arr.length !== width * height)
    throw new ImportError(`values 长度 ${Array.isArray(arr) ? arr.length : '?'} 与栅格 ${width}x${height} 不符`, 'GRID_LENGTH', 'values');
  const frameId = String(o.frameId ?? 'frame');
  const diagnostics: string[] = [];
  const nums: number[] = [];
  const reps: string[] = [];
  const min = typeof o.rangeMin === 'number' ? (o.rangeMin as number) : -Math.PI;
  const max = typeof o.rangeMax === 'number' ? (o.rangeMax as number) : Math.PI;
  arr.forEach((cell, i) => {
    if (typeof cell === 'number' && Number.isFinite(cell)) {
      nums.push(cell);
      reps.push(String(cell));
      if (cell < min || cell >= max)
        diagnostics.push(`values[${i}]=${cell} 超出包裹范围 [${min},${max})，保留原值并在派生层包裹`);
    } else if (typeof cell === 'string' && Number.isFinite(Number(cell))) {
      nums.push(Number(cell));
      reps.push(cell); // 保留原始表示
    } else {
      throw new ImportError(`values[${i}] 不是数值/数字字符串`, 'BAD_CELL', `values[${i}]`);
    }
  });
  const unit = readUnit(o, 'wrapped_phase');
  const coordinateFrame = readCoordinateFrame(o.coordinateFrame);
  return {
    diagnostics,
    payload: {
      kind: 'wrapped_phase',
      frameId,
      width,
      height,
      raw: nums,
      rawRepresentation: reps,
      range: { minInclusive: min, maxExclusive: max, unit },
      coordinateFrame
    }
  };
}

export function parseAmplitude(raw: unknown): ImportResult<AmplitudeInput> {
  const o = requireObject(raw, 'amplitude');
  const { width, height } = readDims(o);
  if (!Array.isArray(o.values) || o.values.length !== width * height)
    throw new ImportError('振幅栅格长度不符', 'GRID_LENGTH', 'values');
  const nums: number[] = [];
  const reps: string[] = [];
  o.values.forEach((cell: unknown, i: number) => {
    if (typeof cell === 'number' && Number.isFinite(cell) && cell >= 0) {
      nums.push(cell);
      reps.push(String(cell));
    } else if (typeof cell === 'string' && Number.isFinite(Number(cell))) {
      nums.push(Number(cell));
      reps.push(cell);
    } else throw new ImportError(`振幅 values[${i}] 非法或为负`, 'BAD_CELL', `values[${i}]`);
  });
  return {
    diagnostics: [],
    payload: {
      kind: 'amplitude',
      frameId: String(o.frameId ?? 'frame'),
      width,
      height,
      raw: nums,
      rawRepresentation: reps,
      unit: readUnit(o, 'amplitude')
    }
  };
}

export function parseInvalidMask(raw: unknown): ImportResult<InvalidMaskInput> {
  const o = requireObject(raw, 'invalid_mask');
  const { width, height } = readDims(o);
  if (!Array.isArray(o.valid) || o.valid.length !== width * height)
    throw new ImportError('遮罩长度不符', 'GRID_LENGTH', 'valid');
  const valid = o.valid.map((cell: unknown, i: number) => {
    if (cell === 1 || cell === 0 || cell === true || cell === false) return (cell ? 1 : 0) as 0 | 1;
    throw new ImportError(`valid[${i}] 必须为 0/1`, 'BAD_MASK', `valid[${i}]`);
  });
  return {
    diagnostics: [],
    payload: {
      kind: 'invalid_mask',
      frameId: String(o.frameId ?? 'frame'),
      width, height, valid,
      reason: String(o.reason ?? 'manual_or_instrument')
    }
  };
}

export function parseWavelength(raw: unknown): ImportResult<WavelengthInput> {
  const o = requireObject(raw, 'wavelength');
  const value = requireNumber(o.value, 'value');
  const unit = readUnit(o, 'wavelength');
  if (unit.kind !== 'length') throw new ImportError('波长单位必须是长度', 'BAD_UNIT', 'unit');
  return {
    diagnostics: [],
    payload: {
      kind: 'wavelength',
      value,
      rawRepresentation: String(o.rawRepresentation ?? `${value} ${unit.symbol}`),
      unit
    }
  };
}

export function parseGeometry(raw: unknown): ImportResult<IlluminationGeometryInput> {
  const o = requireObject(raw, 'illumination_geometry');
  const vec = (name: string) => {
    const v = requireObject(o[name], name);
    return {
      x: requireNumber(v.x, `${name}.x`),
      y: requireNumber(v.y, `${name}.y`),
      z: requireNumber(v.z, `${name}.z`)
    };
  };
  const diagnostics: string[] = [];
  const sourceDirection = vec('sourceDirection');
  const observerDirection = vec('observerDirection');
  if (Math.hypot(sourceDirection.x, sourceDirection.y, sourceDirection.z) === 0)
    diagnostics.push('source_direction_zero：灵敏度向量将不可用，高度链会保留诊断而非猜测');
  let sensitivityHint;
  if (o.sensitivityHint) sensitivityHint = vec('sensitivityHint');
  return {
    diagnostics,
    payload: {
      kind: 'illumination_geometry',
      sourceDirection,
      observerDirection,
      sensitivityHint,
      rawRepresentation: String(
        o.rawRepresentation ??
          JSON.stringify({ in: sourceDirection, obs: observerDirection })
      ),
      coordinateFrame: readCoordinateFrame(o.coordinateFrame)
    }
  };
}

export function parseCalibration(raw: unknown): ImportResult<CalibrationPlaneInput> {
  const o = requireObject(raw, 'calibration_plane');
  const normal = {
    x: requireNumber(o.normal && (o.normal as Record<string, unknown>).x, 'normal.x'),
    y: requireNumber(o.normal && (o.normal as Record<string, unknown>).y, 'normal.y'),
    z: requireNumber(o.normal && (o.normal as Record<string, unknown>).z, 'normal.z')
  };
  return {
    diagnostics: [],
    payload: {
      kind: 'calibration_plane',
      normal,
      offset: requireNumber(o.offset, 'offset'),
      offsetUnit: readUnit({ unit: o.offsetUnit } as Record<string, unknown>, 'offsetUnit'),
      residualRms: requireNumber(o.residualRms ?? 0, 'residualRms'),
      residualUnit: readUnit({ unit: o.residualUnit } as Record<string, unknown>, 'residualUnit'),
      rawRepresentation: String(o.rawRepresentation ?? JSON.stringify({ normal, offset: o.offset }))
    }
  };
}

export function parseCutHistory(raw: unknown): ImportResult<CutEditHistoryInput> {
  const o = requireObject(raw, 'cut_edit_history');
  if (!Array.isArray(o.entries)) throw new ImportError('entries 必须为数组', 'NOT_ARRAY', 'entries');
  const entries = o.entries.map((e: unknown, i: number) => {
    const x = requireObject(e, `entries[${i}]`);
    const edge = requireObject(x.edge, `entries[${i}].edge`);
    const pa = Array.isArray(edge.a) ? edge.a : null;
    const pb = Array.isArray(edge.b) ? edge.b : null;
    if (!pa || !pb || pa.length !== 2 || pb.length !== 2)
      throw new ImportError('edge.a/edge.b 必须为 [u,v]', 'BAD_EDGE', `entries[${i}].edge`);
    const action = String(x.action);
    if (!['add', 'remove', 'confirm', 'retract'].includes(action))
      throw new ImportError(`未知编辑动作 ${action}`, 'BAD_ACTION', `entries[${i}].action`);
    return {
      at: String(x.at ?? new Date(0).toISOString()),
      editor: String(x.editor ?? 'unknown'),
      action: action as CutEditHistoryInput['entries'][number]['action'],
      edge: { a: pa.map(Number) as [number, number], b: pb.map(Number) as [number, number] },
      ...(x.note ? { note: String(x.note) } : {})
    };
  });
  return { diagnostics: [], payload: { kind: 'cut_edit_history', entries } };
}

function readCoordinateFrame(raw: unknown): CoordinateFrame {
  const o = requireObject(raw ?? {}, 'coordinateFrame');
  const step = (name: string) => {
    const s = requireObject(o[name], name);
    return { value: requireNumber(s.value, `${name}.value`), unit: readUnit(s, name) };
  };
  return {
    id: String(o.id ?? 'lab-frame'),
    origin: 'top-left',
    axisU: 'column',
    axisV: 'row',
    pitchU: step('pitchU'),
    pitchV: step('pitchV')
  };
}
