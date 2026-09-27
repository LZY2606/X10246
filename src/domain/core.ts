// 领域核心：稳定身份、内容哈希、虚拟时钟、定种子随机、单位与坐标基准。
import { createHash } from 'node:crypto';

/** 稳定身份：实体 id / 版本 id / 事件 id 的全局形态。 */
export type EntityId = string;
export type VersionId = string;
export type EventId = string;

export function contentHash(content: unknown): string {
  const text = typeof content === 'string' ? content : stableStringify(content);
  return 'sha256:' + createHash('sha256').update(text).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** 虚拟时钟：所有测试与演示共用，绝不读墙钟。 */
export class VirtualClock {
  private now: number;
  constructor(startIso = '2026-01-05T09:00:00.000Z') {
    this.now = Date.parse(startIso);
  }
  tick(stepMs = 1000): number {
    this.now += stepMs;
    return this.now;
  }
  current(): number {
    return this.now;
  }
}

/** 定种子随机（mulberry32），保证测试与案例包可复现。 */
export class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

/** id 发生器：由虚拟时钟 + 序号派生，跨进程可复现。 */
export class IdFactory {
  private seq = 0;
  private readonly prefixSalt: string;
  private readonly clock: VirtualClock;
  constructor(prefixSalt: string, clock: VirtualClock) {
    this.prefixSalt = prefixSalt;
    this.clock = clock;
  }
  next(kind: string): string {
    this.seq += 1;
    const raw = `${this.prefixSalt}|${kind}|${this.clock.current()}|${this.seq}`;
    const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return `${kind}_${digest}`;
  }
}

// ---------------------------------------------------------------------------
// 单位与坐标基准：所有领域量都携带单位或坐标基准；导入层保留原始表示。
// ---------------------------------------------------------------------------

export type Unit = 'rad' | 'nm' | 'um' | 'mm' | 'deg' | 'count' | 'ratio' | 'px';
export type CoordFrame = 'pixel' | 'sample' | 'lab';

export interface Quantity {
  value: number;
  unit: Unit;
  frame?: CoordFrame;
}

export interface GridQuantity {
  /** 行主序二维网格。 */
  values: number[][];
  unit: Unit;
  frame: CoordFrame;
}

const UNIT_SCALE_TO_BASE: Partial<Record<Unit, number>> = {
  nm: 1,
  um: 1000,
  mm: 1_000_000,
  deg: Math.PI / 180,
  rad: 1,
};

export class UnitConversionError extends Error {
  readonly from: Unit;
  readonly to: Unit;
  constructor(from: Unit, to: Unit) {
    super(`无法转换单位: ${from} -> ${to}`);
    this.name = 'UnitConversionError';
    this.from = from;
    this.to = to;
  }
}

/** 派生层才做规范化；无法转换时抛错，由调用方留在原位置并附诊断。 */
export function convertQuantity(q: Quantity, to: Unit): Quantity {
  if (q.unit === to) return q;
  const fromScale = UNIT_SCALE_TO_BASE[q.unit];
  const toScale = UNIT_SCALE_TO_BASE[to];
  if (fromScale === undefined || toScale === undefined) {
    throw new UnitConversionError(q.unit, to);
  }
  // 只允许同族转换（长度族 / 角度族）。
  const lengthUnits: Unit[] = ['nm', 'um', 'mm'];
  const angleUnits: Unit[] = ['rad', 'deg'];
  const sameFamily =
    (lengthUnits.includes(q.unit) && lengthUnits.includes(to)) ||
    (angleUnits.includes(q.unit) && angleUnits.includes(to));
  if (!sameFamily) throw new UnitConversionError(q.unit, to);
  return { value: (q.value * fromScale) / toScale, unit: to, frame: q.frame };
}

/** 参数指纹：算法参数的稳定摘要，派生值必须携带。 */
export function paramFingerprint(params: unknown): string {
  return contentHash(params).slice(0, 24);
}
