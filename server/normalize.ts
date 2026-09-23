import type {
  CalibrationSurface, CutEditHistory, Grid, IncidenceGeometry,
  RawInputKind, WavelengthQuantity,
} from './types.js';

export interface NormalizeResult {
  normalized: unknown | null;
  diagnostics: string[];
  unit: string | null;
  frame: string | null;
}

// 派生层规范化：原始表示已在 raw_json 保留；无法转换的值留在原位置并附诊断
export function normalizeRaw(kind: RawInputKind, raw: unknown): NormalizeResult {
  const diagnostics: string[] = [];
  const fail = (msg: string): NormalizeResult => {
    diagnostics.push(msg);
    return { normalized: null, diagnostics, unit: null, frame: null };
  };
  if (typeof raw !== 'object' || raw === null) return fail('原始载荷必须是对象');
  const q = raw as Record<string, unknown>;
  if (typeof q.unit !== 'string' || typeof q.frame !== 'string') {
    return fail('缺少单位(unit)或坐标基准(frame)：所有领域量必须携带单位或坐标基准');
  }
  const unit = q.unit as string;
  const frame = q.frame as string;

  if (kind === 'wrapped_phase' || kind === 'snr_score' || kind === 'invalid_mask') {
    const v = q.value as Record<string, unknown> | undefined;
    if (!v || typeof v.width !== 'number' || typeof v.height !== 'number' || !Array.isArray(v.values)) {
      return fail('网格量必须包含 width/height/values');
    }
    const n = v.width * v.height;
    if (v.values.length !== n) return fail(`网格长度 ${v.values.length} 与 ${v.width}x${v.height} 不符`);
    const values: (number | null)[] = [];
    for (let i = 0; i < n; i++) {
      const cell = (v.values as unknown[])[i];
      if (cell === null) { values.push(null); continue; }
      const num = Number(cell);
      if (!Number.isFinite(num)) {
        diagnostics.push(`像素 ${i} 无法转换为数值，保留原位置并置为无效: ${JSON.stringify(cell)}`);
        values.push(null);
        continue;
      }
      values.push(num);
    }
    if (kind === 'wrapped_phase' && unit !== 'rad' && unit !== 'deg') {
      diagnostics.push(`包裹相位单位为 ${unit}，派生层按 rad 解释前需要人工确认`);
    }
    const grid: Grid = { width: v.width, height: v.height, values };
    return { normalized: grid, diagnostics, unit, frame };
  }
  if (kind === 'wavelength') {
    const num = Number(q.value);
    if (!Number.isFinite(num) || num <= 0) return fail(`波长无法转换为正数: ${JSON.stringify(q.value)}`);
    if (unit !== 'nm') diagnostics.push(`波长单位为 ${unit}，派生层需要 nm；当前值按原单位保留在原始层`);
    const w: WavelengthQuantity = { value: num, unit, frame };
    return { normalized: w, diagnostics, unit, frame };
  }
  if (kind === 'incidence_geometry') {
    const v = q.value as Record<string, unknown> | undefined;
    const theta = Number(v?.thetaDeg), az = Number(v?.azimuthDeg);
    if (!Number.isFinite(theta) || !Number.isFinite(az)) {
      return fail('入射几何缺少可转换的 thetaDeg/azimuthDeg');
    }
    const g: IncidenceGeometry = {
      value: { thetaDeg: theta, azimuthDeg: az, doublePass: v?.doublePass !== false },
      unit, frame,
    };
    return { normalized: g, diagnostics, unit, frame };
  }
  if (kind === 'calibration_surface') {
    const v = q.value as Record<string, unknown> | undefined;
    const flat = Number(v?.referenceFlatNm);
    if (!Number.isFinite(flat)) return fail('标定面缺少 referenceFlatNm');
    const c: CalibrationSurface = {
      value: {
        referenceFlatNm: flat,
        tiltXNmPerPx: Number.isFinite(Number(v?.tiltXNmPerPx)) ? Number(v?.tiltXNmPerPx) : 0,
        tiltYNmPerPx: Number.isFinite(Number(v?.tiltYNmPerPx)) ? Number(v?.tiltYNmPerPx) : 0,
      },
      unit, frame,
    };
    return { normalized: c, diagnostics, unit, frame };
  }
  if (kind === 'cut_edit_history') {
    if (!Array.isArray(q.value)) return fail('切口编辑历史必须是数组');
    const records = (q.value as unknown[]).flatMap((rec, i) => {
      const r = rec as Record<string, unknown>;
      const edge = r.edge as Record<string, unknown> | undefined;
      const ok = (r.op === 'add_cut' || r.op === 'remove_cut') && edge
        && Number.isInteger(edge.x) && Number.isInteger(edge.y)
        && (edge.dir === 'h' || edge.dir === 'v');
      if (!ok) {
        diagnostics.push(`切口编辑记录 ${i} 无法转换，保留在原始层: ${JSON.stringify(rec)}`);
        return [];
      }
      return [{ op: r.op, edge: { x: edge.x, y: edge.y, dir: edge.dir }, editor: String(r.editor ?? 'unknown'), note: r.note }];
    });
    const h: CutEditHistory = { value: records as CutEditHistory['value'], unit, frame };
    return { normalized: h, diagnostics, unit, frame };
  }
  return fail(`未支持的类别: ${kind}`);
}
