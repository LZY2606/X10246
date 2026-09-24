// 虚拟时钟：测试使用固定起点、确定性步进；不接触系统时钟。
export class VirtualClock {
  private nowMs: number;
  private readonly stepMs: number;

  constructor(startIso = '2026-01-01T00:00:00.000Z', stepMs = 1) {
    this.nowMs = Date.parse(startIso);
    this.stepMs = stepMs;
  }

  now(): number {
    const t = this.nowMs;
    this.nowMs += this.stepMs;
    return t;
  }

  peek(): number {
    return this.nowMs;
  }

  advance(ms: number): number {
    this.nowMs += ms;
    return this.nowMs;
  }

  reset(startIso = '2026-01-01T00:00:00.000Z'): void {
    this.nowMs = Date.parse(startIso);
  }
}
