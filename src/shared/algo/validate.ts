import type {
  ArtifactKind, CoordinateBasis, Diagnostic, FrameTile, IlluminationGeometry,
  CalibrationPlane, CutEditHistoryPayload, Quantity, Unit, WavelengthSpec
} from '../../shared/types';

export interface ImportError {
  code: 'FORMAT_ERROR' | 'MISSING_REFERENCE';
  message: string;
  path: string;
}

export interface FrameDraft {
  kind: ArtifactKind;
  frame: FrameTile;
  basis?: CoordinateBasis;
}
export type InputDraft =
  | { kind: 'wrapped_phase_frame' | 'amplitude_frame' | 'quality_score_map' | 'invalid_mask'; frame: FrameTile; basis?: CoordinateBasis }
  | { kind: 'wavelength_spec'; wavelength: WavelengthSpec }
  | { kind: 'illumination_geometry'; geometry: IlluminationGeometry }
  | { kind: 'calibration_plane'; calibration: CalibrationPlane }
  | { kind: 'cut_edit_history'; cutHistory: CutEditHistoryPayload };

const FRAME_KINDS = new Set(['wrapped_phase_frame', 'amplitude_frame', 'quality_score_map', 'invalid_mask']);
const VALID_UOM = new Set([
  'rad_wrapped', 'gray_amplitude', 'snr_db', 'unitless_quality', 'unitless',
  'rad_unwrapped', 'metres_height', 'metres_wavelength'
]);

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function parseQuantity(raw: unknown, path: string, expectedUom: string, errors: ImportError[], diags: Diagnostic[]): Quantity {
  if (raw === null || raw === undefined) {
    diags.push({ code: 'UNCONVERTIBLE_VALUE', message: `${path} 缺失，保留未知`, severity: 'warning', refs: [path] });
    return { value: null, uom: expectedUom, raw: { repr: String(raw), uom: expectedUom }, diagnostics: [] };
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return { value: raw, uom: expectedUom };
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const uom = typeof obj.uom === 'string' ? obj.uom : expectedUom;
    if (!isNum(obj.value)) {
      diags.push({ code: 'UNCONVERTIBLE_VALUE', message: `${path} 无法转换为 ${uom}`, severity: 'warning', refs: [path] });
      return { value: null, uom, raw: { repr: String(obj.repr ?? obj.value), uom }, diagnostics: [] };
    }
    return { value: obj.value as number, uom };
  }
  diags.push({ code: 'UNCONVERTIBLE_VALUE', message: `${path} 非数值: ${String(raw)}`, severity: 'warning', refs: [path] });
  return { value: null, uom: expectedUom, raw: { repr: String(raw) as string, uom: expectedUom }, diagnostics: [] };
}

export function validateInput(raw: Record<string, unknown>): { draft?: InputDraft; errors: ImportError[]; diagnostics: Diagnostic[] } {
  const errors: ImportError[] = [];
  const diagnostics: Diagnostic[] = [];
  const kind = raw.kind;
  if (typeof kind !== 'string') {
    errors.push({ code: 'FORMAT_ERROR', message: '缺少 kind', path: 'kind' });
    return { errors, diagnostics };
  }

  if (FRAME_KINDS.has(kind)) {
    const rows = raw.rows;
    const cols = raw.cols;
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || (rows as number) <= 0 || (cols as number) <= 0) {
      errors.push({ code: 'FORMAT_ERROR', message: 'rows/cols 必须为正整数', path: 'rows,cols' });
      return { errors, diagnostics };
    }
    if (!Array.isArray(raw.values)) {
      errors.push({ code: 'FORMAT_ERROR', message: 'values 必须是数组', path: 'values' });
      return { errors, diagnostics };
    }
    const expected = (rows as number) * (cols as number);
    if (raw.values.length !== expected) {
      errors.push({ code: 'FORMAT_ERROR', message: `values 长度 ${raw.values.length} 与 rows*cols=${expected} 不符`, path: 'values' });
      return { errors, diagnostics };
    }
    const unitRaw = (raw.unit ?? {}) as Record<string, unknown>;
    const uom = typeof unitRaw.uom === 'string' ? unitRaw.uom : kind === 'wrapped_phase_frame' ? 'rad_wrapped'
      : kind === 'amplitude_frame' ? 'gray_amplitude'
      : kind === 'quality_score_map' ? 'snr_db' : 'unitless';
    if (!VALID_UOM.has(uom)) {
      errors.push({ code: 'FORMAT_ERROR', message: `未知单位 ${uom}`, path: 'unit.uom' });
      return { errors, diagnostics };
    }
    const unit: Unit = {
      uom: uom as Unit['uom'],
      ...(isNum(unitRaw.scale) ? { scale: unitRaw.scale } : {}),
      ...(isNum(unitRaw.offset) ? { offset: unitRaw.offset } : {})
    };
    const values: (number | null)[] = new Array(expected).fill(null);
    raw.values.forEach((v, idx) => {
      const path = `values[${idx}]`;
      if (v === null || v === undefined) {
        values[idx] = null;
        return;
      }
      if (typeof v === 'number' && Number.isFinite(v)) {
        values[idx] = v;
        return;
      }
      if (typeof v === 'object' && isNum((v as Record<string, unknown>).value)) {
        values[idx] = (v as Record<string, number>).value;
        return;
      }
      values[idx] = null;
      const at: [number, number] = [Math.floor(idx / (cols as number)), idx % (cols as number)];
      diagnostics.push({ code: 'UNCONVERTIBLE_VALUE', message: `栅格值无法转换，保留原位: ${String(v)}`, severity: 'warning', at, refs: [path] });
    });
    if (kind === 'invalid_mask') {
      values.forEach((v, idx) => {
        if (v !== null && v !== 0 && v !== 1) {
          values[idx] = null;
          const at: [number, number] = [Math.floor(idx / (cols as number)), idx % (cols as number)];
          diagnostics.push({ code: 'UNCONVERTIBLE_VALUE', message: '遮罩只接受 0/1，该位置按无效保留', severity: 'warning', at });
        }
      });
    }
    if (kind === 'wrapped_phase_frame') {
      values.forEach((v, idx) => {
        if (v !== null && (v < -Math.PI - 1e-9 || v > Math.PI + 1e-9)) {
          const at: [number, number] = [Math.floor(idx / (cols as number)), idx % (cols as number)];
          diagnostics.push({ code: 'CUT_CROSSING', message: '包裹相位超出 [-π,π]，派生层将重新包裹（原始值保留）', severity: 'info', at });
        }
      });
    }
    const tile: FrameTile = { kind: kind as FrameTile['kind'], unit, rows: rows as number, cols: cols as number, values };
    let basis: CoordinateBasis | undefined;
    if (raw.basis && typeof raw.basis === 'object') {
      const b = raw.basis as Record<string, unknown>;
      basis = {
        origin: Array.isArray(b.origin) ? (b.origin as number[]).slice(0, 2) as [number, number] : [0, 0],
        pixelPitch: Array.isArray(b.pixelPitch) ? (b.pixelPitch as number[]).slice(0, 2) as [number, number] : [1, 1],
        pitchUom: 'metres',
        crs: typeof b.crs === 'string' ? b.crs : 'sensor-grid',
        sensorRows: rows as number,
        sensorCols: cols as number
      };
    }
    return { draft: { kind: kind as InputDraft extends { kind: infer K } ? K : never, frame: tile, ...(basis ? { basis } : {}) } as InputDraft, errors, diagnostics };
  }

  if (kind === 'wavelength_spec') {
    const wavelength = parseQuantity(raw.wavelength, 'wavelength', 'metres_wavelength', errors, diagnostics);
    const spec: WavelengthSpec = {
      wavelength,
      effectiveWavelengthFormula: typeof raw.effectiveWavelengthFormula === 'string' ? raw.effectiveWavelengthFormula : 'lambda/2',
      formulaVersion: typeof raw.formulaVersion === 'string' ? raw.formulaVersion : 'wv-1'
    };
    return { draft: { kind, wavelength: spec }, errors, diagnostics };
  }

  if (kind === 'illumination_geometry') {
    const g: IlluminationGeometry = {
      kind: raw.geometryKind === 'off_axis_illumination' ? 'off_axis_illumination' : 'normal_incidence',
      illuminationAngleDeg: parseQuantity(raw.illuminationAngleDeg, 'illuminationAngleDeg', 'degrees', errors, diagnostics),
      observationAngleDeg: parseQuantity(raw.observationAngleDeg, 'observationAngleDeg', 'degrees', errors, diagnostics),
      sensitivityFormula: typeof raw.sensitivityFormula === 'string' ? raw.sensitivityFormula : 'lambda/(cos(theta_i)+cos(theta_o))*dphi/2pi',
      formulaVersion: typeof raw.formulaVersion === 'string' ? raw.formulaVersion : 'geo-1'
    };
    return { draft: { kind, geometry: g }, errors, diagnostics };
  }

  if (kind === 'calibration_plane') {
    const coeffs: Record<string, Quantity> = {};
    const rawCoeffs = (raw.coefficients ?? {}) as Record<string, unknown>;
    for (const [key, val] of Object.entries(rawCoeffs)) {
      coeffs[key] = parseQuantity(val, `coefficients.${key}`, 'dimensionless_coeff', errors, diagnostics);
    }
    const cal: CalibrationPlane = {
      planeEquation: typeof raw.planeEquation === 'string' ? raw.planeEquation : 'z = a*x + b*y + c',
      coefficients: coeffs,
      residualRms: parseQuantity(raw.residualRms, 'residualRms', 'metres_height', errors, diagnostics),
      ...(typeof raw.calibrationFrameRef === 'string' ? { calibrationFrameRef: raw.calibrationFrameRef } : {})
    };
    return { draft: { kind, calibration: cal }, errors, diagnostics };
  }

  if (kind === 'cut_edit_history') {
    if (!Array.isArray(raw.edits)) {
      errors.push({ code: 'FORMAT_ERROR', message: 'edits 必须是数组', path: 'edits' });
      return { errors, diagnostics };
    }
    const edits = raw.edits.map((e, i) => {
      const ed = (e ?? {}) as Record<string, unknown>;
      if (!['add_cut', 'remove_cut', 'pin_offset', 'unpin'].includes(String(ed.action))) {
        errors.push({ code: 'FORMAT_ERROR', message: `未知切口动作 @${i}`, path: `edits[${i}].action` });
      }
      return {
        editId: typeof ed.editId === 'string' ? ed.editId : `edit-${i}`,
        action: String(ed.action) as 'add_cut',
        ...(Array.isArray(ed.edge) ? { edge: ed.edge as [[number, number], [number, number]] } : {}),
        ...(isNum(ed.integerOffset) ? { integerOffset: ed.integerOffset as number } : {}),
        reason: typeof ed.reason === 'string' ? ed.reason : '',
        operator: typeof ed.operator === 'string' ? ed.operator : 'lab-operator'
      };
    });
    if (errors.length) return { errors, diagnostics };
    return { draft: { kind, cutHistory: { edits } }, errors, diagnostics };
  }

  errors.push({ code: 'FORMAT_ERROR', message: `未知输入实体 kind: ${kind}`, path: 'kind' });
  return { errors, diagnostics };
}
