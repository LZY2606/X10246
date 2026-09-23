import type { Diagnostic, Grid, RawContent, RawKind } from '../shared/types.ts';

export class FormatError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => `${d.code}: ${d.message}`).join('; '));
    this.diagnostics = diagnostics;
  }
}

function isGrid(v: unknown): v is Grid {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((row) => Array.isArray(row) && row.length > 0 && row.every((x) => typeof x === 'number' && Number.isFinite(x)))
  );
}

function rectangular(g: Grid): boolean {
  const cols = g[0]?.length ?? 0;
  return g.every((row) => row.length === cols);
}

function isMask(v: unknown): v is boolean[][] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((row) => Array.isArray(row) && row.length > 0 && row.every((x) => typeof x === 'boolean'))
  );
}

/** 导入层校验：结构错误直接拒绝并给出明确诊断 */
export function validateRawContent(kind: RawKind, content: unknown): RawContent {
  const errors: Diagnostic[] = [];
  const c = content as Record<string, unknown> | null;
  const fail = (code: string, message: string, at?: string) =>
    errors.push({ code, message, at });

  if (c === null || typeof c !== 'object') {
    throw new FormatError([{ code: 'format.not-object', message: '输入必须是 JSON 对象' }]);
  }
  if (c.kind !== kind) {
    fail('format.kind-mismatch', `内容 kind '${String(c.kind)}' 与声明的 '${kind}' 不一致`, 'kind');
  }

  switch (kind) {
    case 'wrapped_phase': {
      const pixels = c.pixels as { value?: unknown; unit?: unknown } | undefined;
      if (!pixels || !isGrid(pixels.value)) {
        fail('format.pixels', 'wrapped_phase.pixels.value 必须是非空二维数字数组', 'pixels.value');
      } else {
        if (!rectangular(pixels.value)) fail('format.not-rectangular', '像素网格必须矩形', 'pixels.value');
        if (pixels.unit !== 'rad') fail('format.unit', 'wrapped_phase 单位必须是 rad', 'pixels.unit');
        for (const [r, row] of (pixels.value as Grid).entries()) {
          for (const [cIdx, v] of row.entries()) {
            if (v <= -Math.PI || v > Math.PI) {
              fail(
                'format.range',
                `包裹相位超出 (-π, π]：${v} @ [${r},${cIdx}]`,
                `pixels.value[${r}][${cIdx}]`,
              );
            }
          }
        }
      }
      break;
    }
    case 'amplitude': {
      const pixels = c.pixels as { value?: unknown; unit?: unknown } | undefined;
      if (!pixels || !isGrid(pixels.value)) {
        fail('format.pixels', 'amplitude.pixels.value 必须是非空二维数字数组', 'pixels.value');
      } else {
        if (!rectangular(pixels.value)) fail('format.not-rectangular', '像素网格必须矩形', 'pixels.value');
        if (pixels.unit !== 'count') fail('format.unit', 'amplitude 单位必须是 count', 'pixels.unit');
      }
      break;
    }
    case 'invalid_mask': {
      if (!isMask(c.mask)) fail('format.mask', 'invalid_mask.mask 必须是非空二维布尔数组', 'mask');
      break;
    }
    case 'wavelength': {
      const w = c.wavelength as { value?: unknown } | undefined;
      if (!w || typeof w.value !== 'number' || !(w.value > 0)) {
        fail('format.wavelength', 'wavelength.value 必须是正数', 'wavelength.value');
      }
      break;
    }
    case 'incidence_geometry': {
      for (const key of ['thetaIncidence', 'thetaReflection'] as const) {
        const q = c[key] as { value?: unknown } | undefined;
        if (!q || typeof q.value !== 'number') {
          fail('format.geometry', `incidence_geometry.${key}.value 必须是数字`, key);
        }
      }
      break;
    }
    case 'calibration_plane': {
      const q = c.coefficients as { value?: unknown } | undefined;
      if (!q || !Array.isArray(q.value) || q.value.length !== 3 || !q.value.every((x) => typeof x === 'number')) {
        fail('format.calibration', 'calibration_plane.coefficients.value 必须是 [c0, cr, cc] 三个数字', 'coefficients.value');
      }
      break;
    }
    case 'cut_edit_history': {
      if (!Array.isArray(c.edits)) {
        fail('format.edits', 'cut_edit_history.edits 必须是数组', 'edits');
      } else {
        for (const [i, e] of c.edits.entries()) {
          const edit = e as { op?: unknown; edge?: { a?: unknown; b?: unknown } };
          if (edit.op !== 'add' && edit.op !== 'remove') {
            fail('format.edit-op', `edits[${i}].op 必须是 add|remove`, `edits[${i}].op`);
          }
          const isPixel = (p: unknown) => Array.isArray(p) && p.length === 2 && p.every((x) => Number.isInteger(x));
          if (!isPixel(edit.edge?.a) || !isPixel(edit.edge?.b)) {
            fail('format.edit-edge', `edits[${i}].edge 需要两个 [row,col] 像素`, `edits[${i}].edge`);
          }
        }
      }
      break;
    }
  }
  if (errors.length > 0) throw new FormatError(errors);
  return content as RawContent;
}
