import { createHash } from 'node:crypto';

/** 虚拟时间：可注入、单调、可重放；不读取墙上时钟。 */
export class VirtualClock {
  private tick: number;
  readonly epochIso: string;
  constructor(epochIso: string, startTick = 0) {
    this.epochIso = epochIso;
    this.tick = startTick;
  }
  advance(ms = 1): string {
    this.tick += ms;
    return this.iso();
  }
  currentTick(): number {
    return this.tick;
  }
  iso(): string {
    return `${this.epochIso}+${this.tick.toString().padStart(6, '0')}ms`;
  }
  snapshot() {
    return { iso: this.iso(), tick: this.tick };
  }
}

/** 固定 seed 的 mulberry32 PRNG；展开树平局判定时使用，保证跨机一致。 */
export class SeededRng {
  private state: number;
  readonly seed: number;
  constructor(seed: number) {
    this.seed = seed;
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export function sha256Hex(payload: unknown): string {
  const text =
    typeof payload === 'string' ? payload : stableStringify(payload);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 稳定序列化：键排序，保证同一内容任何机器上哈希一致。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' +
    entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') +
    '}'
  );
}

export function fingerprintParams(params: unknown): string {
  return 'fp_' + sha256Hex(params).slice(0, 16);
}

/**
 * 稳定实体身份：同一案例、同一槽位、同一内容 => 同一 id；
 * 派生实体由算法、参数指纹、直接来源版本决定。导出/删除/导入后保持。
 */
export function rawEntityId(caseId: string, slot: string, blobHash: string): string {
  return `${caseId}/raw_${slot}@${blobHash.slice(0, 16)}`;
}

export function derivedEntityId(
  kind: string,
  caseId: string,
  algoVersion: string,
  paramsFingerprint: string,
  refsHash: string
): string {
  const h = sha256Hex(
    [kind, caseId, algoVersion, paramsFingerprint, refsHash].join('|')
  ).slice(0, 16);
  return `${caseId}/${kind}@${h}`;
}
