/** 可注入时钟：生产用真实时钟，测试用虚拟时间 + 固定 seed。 */
export interface Clock {
  nowIso(): string;
  tick(): number;
}

export class VirtualClock implements Clock {
  private counter = 0;
  constructor(private readonly baseIso = "2026-01-01T00:00:00.000Z") {}
  nowIso(): string {
    return this.baseIso;
  }
  tick(): number {
    return ++this.counter;
  }
}

export class SystemClock implements Clock {
  private counter = 0;
  nowIso(): string {
    return new Date().toISOString();
  }
  tick(): number {
    return ++this.counter;
  }
}

/** 固定 seed 的确定性 PRNG（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
