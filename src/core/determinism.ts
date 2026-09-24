import { createHash } from 'node:crypto';

export function sha256Hex(canonical: unknown): string {
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

export function shortHash(canonical: unknown): string {
  return sha256Hex(canonical).slice(0, 12);
}

/** 确定性 JSON：键排序，避免 Map/undefined 影响 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) out[key] = sortDeep(v);
  }
  return out;
}

/** 稳定实体身份：同项目、同类型、同内容 => 同 id；跨导出导入保持不变 */
export function stableEntityId(projectId: string, kind: string, canonicalContent: unknown): string {
  return `${kind}-${shortHash({ p: projectId, k: kind, c: canonicalContent })}`;
}

/** 像素稳定身份：导出删除库再导入后保持 */
export function pixelId(frameId: string, row: number, col: number): string {
  return `${frameId}/px/${row}/${col}`;
}

export function edgeId(a: { row: number; col: number }, b: { row: number; col: number }): string {
  const key = (a.row - b.row !== 0 ? Math.min(a.row, b.row) + ':' + Math.min(a.col, b.col) + '|' + Math.max(a.row, b.row) + ':' + Math.max(a.col, b.col)
    : a.row + ':' + Math.min(a.col, b.col) + '|' + b.row + ':' + Math.max(a.col, b.col));
  return `edge-${shortHash(key)}`;
}

export function cycleId(edgeIds: string[]): string {
  return `cyc-${shortHash([...edgeIds].sort())}`;
}

export function candidateId(componentId: number, root: { row: number; col: number }, treeCanonical: unknown): string {
  return `cand-c${componentId}-r${root.row}-${root.col}-${shortHash(treeCanonical)}`;
}

/** 固定 seed 的确定性 PRNG（LCG） */
export class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    // Numerical Recipes LCG
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  pick<T>(items: T[]): T {
    return items[Math.floor(this.next() * items.length) % items.length]!;
  }
}

/** 虚拟时钟：只由引擎推进 */
export class VirtualClock {
  private nowMs: number;
  constructor(startIso = '2026-01-01T00:00:00.000Z') {
    this.nowMs = Date.parse(startIso);
  }
  tick(stepMs = 1000): number {
    this.nowMs += stepMs;
    return this.nowMs;
  }
  current(): number {
    return this.nowMs;
  }
}
