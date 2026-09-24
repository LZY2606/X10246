/**
 * 固定 seed 的确定性伪随机（mulberry32）。
 * 所有测试与离线案例包都使用固定 seed，不访问公网、不依赖机器状态。
 */
export class SeededRng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** [min,max) 浮点 */
  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  int(min: number, maxExclusive: number): number {
    return Math.floor(this.uniform(min, maxExclusive));
  }
  pick<T>(items: T[]): T {
    return items[this.int(0, items.length)];
  }
}
