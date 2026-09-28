import { createHash } from 'node:crypto';

export function stableHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value).slice(0, 16)}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function requireGrid(value: unknown, field: string, unit: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`FORMAT_ERROR:${field} must be an object`);
  }
  const grid = value as { rows?: unknown; cols?: unknown; values?: unknown; unit?: unknown; coordinateFrame?: unknown };
  if (typeof grid.rows !== 'number' || typeof grid.cols !== 'number') {
    throw new Error(`FORMAT_ERROR:${field}.rows and ${field}.cols must be numbers`);
  }
  if (!Array.isArray(grid.values) || grid.values.length !== grid.rows * grid.cols) {
    throw new Error(`FORMAT_ERROR:${field}.values length must be rows*cols`);
  }
  if (typeof grid.unit !== 'string' || grid.unit !== unit) {
    throw new Error(`FORMAT_ERROR:${field}.unit must be ${unit}`);
  }
  if (typeof grid.coordinateFrame !== 'string' || grid.coordinateFrame.length === 0) {
    throw new Error(`FORMAT_ERROR:${field}.coordinateFrame is required`);
  }
}

export function assert(condition: boolean, code: string, message: string): asserts condition {
  if (!condition) {
    throw new Error(`${code}:${message}`);
  }
}
