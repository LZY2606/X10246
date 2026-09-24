import type { Grid } from '../shared/domain';

export function makeGrid(width: number, height: number, unit: string, coordFrame: string, fill = 0): Grid {
  return { width, height, unit, coordFrame, values: new Array(width * height).fill(fill) };
}
export const idx = (g: Grid, x: number, y: number) => y * g.width + x;
export const inBounds = (g: Grid, x: number, y: number) => x >= 0 && y >= 0 && x < g.width && y < g.height;

/** JSON 往返：NaN <-> null */
export function gridToJson(g: Grid): unknown {
  return { ...g, values: g.values.map((v) => (Number.isFinite(v) ? v : null)) };
}
export function gridFromJson(raw: Grid): Grid {
  return { ...raw, values: raw.values.map((v) => (v === null ? NaN : v)) };
}
/** 反序列化任意 payload 中的网格字段 */
export function reviveGrids<T>(payload: T): T {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const o = v as Record<string, unknown>;
    if (typeof o.width === 'number' && typeof o.height === 'number' && Array.isArray(o.values) && typeof o.unit === 'string') {
      return gridFromJson(o as unknown as Grid);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = walk(o[k]);
    return out;
  };
  return walk(payload) as T;
}
