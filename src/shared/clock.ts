/**
 * 虚拟时间时钟：所有时间戳从固定起点按步进推进，保证重放/测试可重复。
 */
export class VirtualClock {
  private t: number;
  constructor(private readonly epoch = Date.UTC(2026, 0, 1, 0, 0, 0), private stepMs = 1000) {
    this.t = epoch;
  }
  now(): string {
    const iso = new Date(this.t).toISOString();
    this.t += this.stepMs;
    return iso;
  }
  peek(): string {
    return new Date(this.t).toISOString();
  }
  static parse(iso: string): number {
    return Date.parse(iso);
  }
}
