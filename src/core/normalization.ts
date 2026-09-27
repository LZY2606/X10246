import type { ComposedPhaseCanvas, RawFragmentContent } from './domain-types';

export type NormalizedGrid = {
  width: number;
  height: number;
  values: number[][];
  invalid: boolean[][];
  diagnostics: { message: string; pixel?: [number, number] }[];
};

export function numericCell(value: unknown): { number: number | null; diagnostic?: string } {
  if (typeof value === 'number' && Number.isFinite(value)) return { number: value };
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return { number: parsed };
    return { number: null, diagnostic: `无法转换为数字的原始值：${value}` };
  }
  return { number: null, diagnostic: '缺失或无法转换为数字的原始值' };
}

export function normalizeGrid(content: Extract<RawFragmentContent, { gridKind: string }>): NormalizedGrid {
  if (content.gridKind !== 'grid') throw new Error('compose canvas requires tile resolution');
  const width = content.width;
  const height = content.height;
  const values = Array.from({ length: height }, () => Array.from({ length: width }, () => Number.NaN));
  const invalid = Array.from({ length: height }, () => Array.from({ length: width }, () => true));
  const diagnostics: NormalizedGrid['diagnostics'] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = numericCell(content.values[y]?.[x]);
      if (cell.number === null) {
        invalid[y][x] = true;
        diagnostics.push({ message: cell.diagnostic ?? '无效值', pixel: [x, y] });
      } else {
        values[y][x] = cell.number;
        invalid[y][x] = false;
      }
    }
  }
  return { width, height, values, invalid, diagnostics };
}

export function normalizeBooleanMask(content: Extract<RawFragmentContent, { kind: 'invalid_mask' }>): NormalizedGrid {
  const width = content.width;
  const height = content.height;
  const values = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  const invalid = Array.from({ length: height }, () => Array.from({ length: width }, () => true));
  const diagnostics: NormalizedGrid['diagnostics'] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const raw = content.values[y]?.[x];
      const flagged = raw === true || raw === 1 || raw === '1' || raw === 'true';
      values[y][x] = flagged ? 1 : 0;
      invalid[y][x] = false;
      if (!flagged && raw !== false && raw !== 0 && raw !== '0' && raw !== 'false') {
        diagnostics.push({ message: `遮罩原值未能识别，按无效遮罩保留：${String(raw)}`, pixel: [x, y] });
        values[y][x] = 1;
      }
    }
  }
  return { width, height, values, invalid, diagnostics };
}

export function resolveComposedPhase(
  content: ComposedPhaseCanvas,
  tiles: Record<string, number[][]>
): NormalizedGrid {
  const values = Array.from({ length: content.height }, () =>
    Array.from({ length: content.width }, () => Number.NaN)
  );
  const invalid = Array.from({ length: content.height }, () =>
    Array.from({ length: content.width }, () => true)
  );
  const diagnostics: NormalizedGrid['diagnostics'] = [];
  const background = numericCell(content.background);
  for (let y = 0; y < content.height; y += 1) {
    for (let x = 0; x < content.width; x += 1) {
      if (background.number !== null) {
        values[y][x] = background.number;
        invalid[y][x] = false;
      }
    }
  }
  for (const placement of content.placements) {
    const tile = tiles[placement.tileKey];
    if (!tile) {
      diagnostics.push({ message: `组合画布引用的原始片段缺失：${placement.tileKey}` });
      continue;
    }
    for (let y = 0; y < tile.length; y += 1) {
      for (let x = 0; x < tile[y].length; x += 1) {
        const atX = placement.at[0] + x;
        const atY = placement.at[1] + y;
        if (atX >= content.width || atY >= content.height) continue;
        values[atY][atX] = tile[y][x];
        invalid[atY][atX] = !Number.isFinite(tile[y][x]);
      }
    }
  }
  return { width: content.width, height: content.height, values, invalid, diagnostics };
}

export function wrapAngle(angle: number): number {
  let wrapped = angle % (Math.PI * 2);
  if (wrapped <= -Math.PI) wrapped += Math.PI * 2;
  if (wrapped > Math.PI) wrapped -= Math.PI * 2;
  return wrapped;
}
