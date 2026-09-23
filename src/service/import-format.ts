/**
 * 导入层格式校验：接受可复制的小型样例，明确拒绝格式错误。
 * 文本格式（领域材料，不是通用 name/value 表）：
 *
 *   INTERFEROGRAM/1
 *   grid 8 8
 *   wavelength 632.8 nanometer
 *   incidence 35 degree
 *   @phase
 *   <rows*cols 个数值，逗号或空白分隔；支持 NaN>
 *   @amplitude
 *   ...
 *   @snr
 *   ...
 *   @mask
 *   ...
 *
 * 无法转换/越界/计数不符都给出显式诊断，绝不静默丢值。
 */
import { GRID } from '../domain/scenarios.ts';

export interface ParsedSample {
  rows: number;
  cols: number;
  wavelength: { raw: number; unit: string };
  incidence: { raw: number; unit: string };
  phase: number[];
  amplitude: number[];
  snr: number[];
  mask: number[];
}

export interface FormatError {
  code: string;
  line?: number;
  message: string;
}

export function parseSampleText(text: string): { ok: true; sample: ParsedSample } | { ok: false; errors: FormatError[] } {
  const errors: FormatError[] = [];
  const lines = text.split(/\r?\n/);
  let rows = GRID.rows;
  let cols = GRID.cols;
  let wavelength = { raw: 632.8, unit: 'nanometer' };
  let incidence = { raw: 35, unit: 'degree' };
  const blocks: Record<string, number[]> = {};
  let section: string | null = null;

  if (!lines[0] || !lines[0].trim().startsWith('INTERFEROGRAM/1')) {
    errors.push({ code: 'BAD_HEADER', line: 1, message: '首行必须是 INTERFEROGRAM/1' });
  }

  for (let li = 1; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('@')) {
      section = line.slice(1).trim();
      if (!['phase', 'amplitude', 'snr', 'mask'].includes(section)) {
        errors.push({ code: 'UNKNOWN_SECTION', line: li + 1, message: '未知段 @' + section });
      }
      blocks[section] = [];
      continue;
    }
    if (section && ['phase', 'amplitude', 'snr', 'mask'].includes(section)) {
      for (const tok of line.split(/[\s,]+/).filter(Boolean)) {
        if (tok === 'NaN') {
          blocks[section].push(NaN);
          continue;
        }
        const v = Number(tok);
        if (Number.isNaN(v)) {
          errors.push({ code: 'BAD_NUMBER', line: li + 1, message: `无法解析数值 "${tok}"` });
          continue;
        }
        blocks[section].push(v);
      }
      continue;
    }
    if (line.startsWith('grid')) {
      const m = line.split(/\s+/);
      rows = Number(m[1]);
      cols = Number(m[2]);
      if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
        errors.push({ code: 'BAD_GRID', line: li + 1, message: 'grid 需要两个正整数' });
      }
      continue;
    }
    if (line.startsWith('wavelength')) {
      const m = line.split(/\s+/);
      wavelength = { raw: Number(m[1]), unit: m[2] };
      if (Number.isNaN(wavelength.raw)) errors.push({ code: 'BAD_WAVELENGTH', line: li + 1, message: '波长不是数值' });
      continue;
    }
    if (line.startsWith('incidence')) {
      const m = line.split(/\s+/);
      incidence = { raw: Number(m[1]), unit: m[2] };
      continue;
    }
    errors.push({ code: 'UNPARSED_LINE', line: li + 1, message: '无法识别: ' + line });
  }

  const need = rows * cols;
  for (const name of ['phase', 'amplitude', 'snr', 'mask']) {
    const got = blocks[name]?.length ?? 0;
    if (got !== need) {
      errors.push({
        code: 'LENGTH_MISMATCH',
        message: `@${name} 需要 ${need} 个值，实际 ${got}`,
      });
    }
  }
  const mask = blocks.mask ?? [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0 && mask[i] !== 1) {
      errors.push({ code: 'BAD_MASK_VALUE', message: `遮罩必须为 0/1，位置 ${i} 为 ${mask[i]}` });
      break;
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    sample: {
      rows,
      cols,
      wavelength,
      incidence,
      phase: blocks.phase,
      amplitude: blocks.amplitude,
      snr: blocks.snr,
      mask: blocks.mask,
    },
  };
}

/** 生成一个可复制的最小样例文本（固定）。 */
export function sampleText(): string {
  const n = GRID.rows * GRID.cols;
  const row = (fn: (i: number) => number | string) =>
    Array.from({ length: n }, (_, i) => fn(i)).join(', ');
  return [
    'INTERFEROGRAM/1',
    '# 可复制小型样例；NaN 表示缺失，绝不猜值',
    'grid 8 8',
    'wavelength 632.8 nanometer',
    'incidence 35 degree',
    '@phase',
    row((i) => Number((Math.sin(i * 0.6)).toFixed(3))),
    '@amplitude',
    row(() => 0.9),
    '@snr',
    row(() => 0.9),
    '@mask',
    row(() => 1),
  ].join('\n');
}
