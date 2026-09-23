/** 时钟抽象：测试使用虚拟时间，演示使用真实时间，顺序只依赖事件序号。 */
export interface Clock {
  now(): string;
}

export class RealClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class VirtualClock implements Clock {
  private currentMs: number;
  constructor(
    startIso = '2026-01-01T00:00:00.000Z',
    private readonly stepMs = 37000,
  ) {
    this.currentMs = Date.parse(startIso);
  }
  now(): string {
    const iso = new Date(this.currentMs).toISOString();
    this.currentMs += this.stepMs;
    return iso;
  }
}
