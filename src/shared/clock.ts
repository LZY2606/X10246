export interface Clock {
  now(): string;
}

/** 系统时钟（开发服务器用）。 */
export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

/** 虚拟时钟：固定起点、每次调用前进固定步长，测试可完全复现。 */
export class VirtualClock implements Clock {
  private tick: number;
  constructor(
    private readonly startIso = '2035-01-01T00:00:00.000Z',
    private readonly stepMs = 1000,
  ) {
    this.tick = 0;
  }
  now(): string {
    const t = new Date(Date.parse(this.startIso) + this.tick * this.stepMs);
    this.tick += 1;
    return t.toISOString();
  }
}
