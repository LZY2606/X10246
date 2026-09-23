/** 固定 seed 的确定性伪随机（mulberry32），测试与样例完全可复现，不访问公网。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 确定性虚拟时钟：从固定起点按固定步长推进，保证历史时间可重放。 */
export class VirtualClock {
  private current: number;
  private stepMs: number;
  constructor(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1000) {
    this.current = Date.parse(startIso);
    this.stepMs = stepMs;
  }
  now(): string {
    const iso = new Date(this.current).toISOString();
    this.current += this.stepMs;
    return iso;
  }
  peek(): string {
    return new Date(this.current).toISOString();
  }
}
